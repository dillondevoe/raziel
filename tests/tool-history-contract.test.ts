import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine";
import { SessionStore } from "../src/session";
import { Workspace } from "../src/tools/workspace";
import { Rules } from "../src/rules";
import { ApprovalManager } from "../src/approvals";
import { builtinTools } from "../src/tools/registry";
import type { ChatMessage, Provider, StreamChunk } from "../src/provider";
import { toAnthropicMessages } from "../src/providers/anthropic";
import { toPiMessages } from "../src/providers/openai_responses";
import { toOllamaMessages } from "../src/providers/ollama";
import { toPiMessages as toCompatMessages } from "../src/providers/openai_compat";

beforeEach(() => { process.env.RAZIEL_HOME = mkdtempSync(join(tmpdir(), "raziel-test-")); });

async function drain(it: AsyncIterable<{ type: string }>) {
  const out: any[] = []; for await (const e of it) out.push(e); return out;
}
function mkws(): Workspace { return new Workspace(mkdtempSync(join(tmpdir(), "raziel-thc-ws-"))); }
function mkApprovals(ask: (c: string, r: string) => Promise<"allow" | "deny" | "always">): ApprovalManager {
  const p = join(mkdtempSync(join(tmpdir(), "raziel-thc-rules-")), "rules.json");
  return new ApprovalManager(Rules.load(p), { ask: ask as any }, p);
}

/** Per-round scripted provider. `toolCalls` on one entry are ONE round's
 * parallel calls, which is the distinction the round field exists to preserve. */
class Scripted implements Provider {
  readonly name = "scripted";
  calls: ChatMessage[][] = [];
  private i = 0;
  constructor(private rounds: { delta?: string[]; toolCalls?: { id?: string; name: string; args: unknown }[] }[]) {}
  async *stream(opts: { messages: ChatMessage[]; signal?: AbortSignal } & Record<string, any>): AsyncIterable<StreamChunk> {
    this.calls.push(opts.messages);
    const round = this.rounds[Math.min(this.i, this.rounds.length - 1)]!;
    this.i++;
    for (const t of round.delta ?? []) yield { type: "delta", text: t };
    for (const tc of round.toolCalls ?? []) yield { type: "tool_call", id: tc.id ?? crypto.randomUUID(), name: tc.name, args: tc.args };
    yield { type: "done", stopReason: "end" };
  }
}

// ---------------------------------------------------------------------------
// (1) THE DEFECT ITSELF. This is the arm that was red before the contract
// landed: the replayed transcript contained a tool result with no assistant
// turn claiming the call, which is why two live models re-requested an
// already-answered read to the round limit.
// ---------------------------------------------------------------------------
test("a completed tool round replays as assistant(toolCalls) + tool(results), never a bare user message", async () => {
  const store = new SessionStore("thc-1");
  const ws = mkws();
  writeFileSync(join(ws.root, "note.txt"), "the answer is 42");
  const deps = { registry: builtinTools(), ws, approvals: mkApprovals(async () => "allow") };

  const p1 = new Scripted([{ toolCalls: [{ name: "read_file", args: { path: "note.txt" } }] }, { delta: ["ok"] }]);
  await drain(new Engine({ provider: p1, store, model: "m", tools: deps }).send("read it"));

  const p2 = new Scripted([{ delta: ["done"] }]);
  await drain(new Engine({ provider: p2, store, model: "m", tools: deps }).send("what did it say?"));

  const msgs = p2.calls[0]!;
  // No user message may carry the tool output. That stringified form IS the bug.
  expect(msgs.filter((m) => m.role === "user").some((m) => (m as any).content.includes("[tool_result"))).toBe(false);

  const ai = msgs.findIndex((m) => m.role === "assistant" && ((m as any).toolCalls?.length ?? 0) > 0);
  expect(ai).toBeGreaterThanOrEqual(0);
  const asst = msgs[ai] as Extract<ChatMessage, { role: "assistant" }>;
  expect(asst.toolCalls!.map((c) => c.name)).toEqual(["read_file"]);
  expect(asst.content).toBe("");

  // The results message is the NEXT one, and it answers that exact call id.
  const tool = msgs[ai + 1] as Extract<ChatMessage, { role: "tool" }>;
  expect(tool.role).toBe("tool");
  expect(tool.results).toHaveLength(1);
  expect(tool.results[0]!.id).toBe(asst.toolCalls![0]!.id);
  expect(tool.results[0]!.ok).toBe(true);
  expect(tool.results[0]!.output).toContain("the answer is 42");
});

// ---------------------------------------------------------------------------
// (2) The round field earning its place. Two parallel calls in ONE round must
// not replay as two rounds: without a persisted round index the log cannot
// tell those apart, and picking either reading fabricates the model's history.
// ---------------------------------------------------------------------------
test("two parallel calls in one round replay as ONE assistant message, not two rounds", async () => {
  const store = new SessionStore("thc-2");
  const ws = mkws();
  writeFileSync(join(ws.root, "a.txt"), "AAA");
  writeFileSync(join(ws.root, "b.txt"), "BBB");
  const deps = { registry: builtinTools(), ws, approvals: mkApprovals(async () => "allow") };

  const p1 = new Scripted([
    { toolCalls: [{ name: "read_file", args: { path: "a.txt" } }, { name: "read_file", args: { path: "b.txt" } }] },
    { delta: ["ok"] },
  ]);
  await drain(new Engine({ provider: p1, store, model: "m", tools: deps }).send("read both"));

  const p2 = new Scripted([{ delta: ["done"] }]);
  await drain(new Engine({ provider: p2, store, model: "m", tools: deps }).send("again"));

  const msgs = p2.calls[0]!;
  const withCalls = msgs.filter((m) => m.role === "assistant" && ((m as any).toolCalls?.length ?? 0) > 0);
  expect(withCalls).toHaveLength(1);
  expect((withCalls[0] as any).toolCalls).toHaveLength(2);
  const toolMsgs = msgs.filter((m) => m.role === "tool");
  expect(toolMsgs).toHaveLength(1);
  expect((toolMsgs[0] as any).results).toHaveLength(2);
  // Request order is the join for wire formats without ids (ollama), so it is
  // part of the contract, not an accident of iteration.
  expect((toolMsgs[0] as any).results.map((r: any) => r.output.includes("AAA"))).toEqual([true, false]);
});

test("two SEQUENTIAL rounds replay as two assistant messages", async () => {
  const store = new SessionStore("thc-3");
  const ws = mkws();
  writeFileSync(join(ws.root, "a.txt"), "AAA");
  writeFileSync(join(ws.root, "b.txt"), "BBB");
  const deps = { registry: builtinTools(), ws, approvals: mkApprovals(async () => "allow") };

  const p1 = new Scripted([
    { toolCalls: [{ name: "read_file", args: { path: "a.txt" } }] },
    { toolCalls: [{ name: "read_file", args: { path: "b.txt" } }] },
    { delta: ["ok"] },
  ]);
  await drain(new Engine({ provider: p1, store, model: "m", tools: deps }).send("read one then the other"));

  const p2 = new Scripted([{ delta: ["done"] }]);
  await drain(new Engine({ provider: p2, store, model: "m", tools: deps }).send("again"));

  const msgs = p2.calls[0]!;
  expect(msgs.filter((m) => m.role === "assistant" && ((m as any).toolCalls?.length ?? 0) > 0)).toHaveLength(2);
  expect(msgs.filter((m) => m.role === "tool")).toHaveLength(2);
});

// ---------------------------------------------------------------------------
// (3) A denial is CONTENT. Replaying it as an absence leaves a visible call
// with no answer, which is the same starvation in a quieter costume.
// ---------------------------------------------------------------------------
test("a denied call replays with ok:false and its refusal text, not as an absence", async () => {
  const store = new SessionStore("thc-4");
  const ws = mkws();
  const deps = { registry: builtinTools(), ws, approvals: mkApprovals(async () => "deny") };

  const p1 = new Scripted([{ toolCalls: [{ name: "write_file", args: { path: "x.txt", content: "no" } }] }, { delta: ["ok"] }]);
  await drain(new Engine({ provider: p1, store, model: "m", tools: deps }).send("write it"));

  const p2 = new Scripted([{ delta: ["done"] }]);
  await drain(new Engine({ provider: p2, store, model: "m", tools: deps }).send("again"));

  const tool = p2.calls[0]!.find((m) => m.role === "tool") as Extract<ChatMessage, { role: "tool" }>;
  expect(tool).toBeDefined();
  expect(tool.results[0]!.ok).toBe(false);
  expect(tool.results[0]!.output).toContain("denied by user");
});

// ---------------------------------------------------------------------------
// (4) Resume replays identically. STATED HONESTLY: this arm was GREEN before
// the contract landed -- the old builder was deterministic too, just
// deterministically wrong. It is a regression guard on the new grouping (a
// Map iteration order or a per-call timestamp leaking in would break it), not
// evidence that the defect existed. The four arms above are the discriminating
// ones; all four were shown red against the pre-change builder.
// ---------------------------------------------------------------------------
test("resume rebuilds the identical transcript from the log alone", async () => {
  const store = new SessionStore("thc-5");
  const ws = mkws();
  writeFileSync(join(ws.root, "note.txt"), "42");
  const deps = { registry: builtinTools(), ws, approvals: mkApprovals(async () => "allow") };

  const p1 = new Scripted([{ toolCalls: [{ name: "read_file", args: { path: "note.txt" } }] }, { delta: ["ok"] }]);
  await drain(new Engine({ provider: p1, store, model: "m", tools: deps }).send("read"));

  const a = new Scripted([{ delta: ["x"] }]);
  await drain(new Engine({ provider: a, store: new SessionStore("thc-5"), model: "m", tools: deps }).send("q"));
  const b = new Scripted([{ delta: ["x"] }]);
  await drain(new Engine({ provider: b, store: new SessionStore("thc-5"), model: "m", tools: deps }).send("q"));

  const strip = (ms: ChatMessage[]) => ms.slice(0, ms.length - 1);
  expect(JSON.stringify(strip(b.calls[0]!).slice(0, 3))).toBe(JSON.stringify(strip(a.calls[0]!).slice(0, 3)));
});

// ---------------------------------------------------------------------------
// (5) anthropic mapping.
// ---------------------------------------------------------------------------
test("anthropic: a round maps to tool_use blocks then ONE user message of tool_result blocks", () => {
  const out = toAnthropicMessages([
    { role: "user", content: "hi" },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", args: { path: "a" } }, { id: "c2", name: "read_file", args: { path: "b" } }] },
    { role: "tool", results: [{ id: "c1", name: "read_file", ok: true, output: "A" }, { id: "c2", name: "read_file", ok: false, output: "boom" }] },
  ]);
  expect(out).toHaveLength(3);
  const asst = out[1]! as { role: string; content: any[] };
  // content "" must be OMITTED, not sent as an empty text block: the API rejects it.
  expect(asst.content.every((b) => b.type === "tool_use")).toBe(true);
  expect(asst.content.map((b) => b.id)).toEqual(["c1", "c2"]);
  const res = out[2]! as { role: string; content: any[] };
  expect(res.role).toBe("user");
  expect(res.content).toHaveLength(2);
  expect(res.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "c1", content: "A", is_error: false });
  expect(res.content[1]).toMatchObject({ tool_use_id: "c2", is_error: true });
});

test("anthropic: the OAuth rename reaches replayed tool_use names, not only the declarations", () => {
  const out = toAnthropicMessages(
    [{ role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", args: {} }] }],
    (n) => (n === "read_file" ? "Read" : n),
  );
  expect((out[0]! as any).content[0].name).toBe("Read");
});

test("anthropic: assistant prose survives alongside its tool calls", () => {
  const out = toAnthropicMessages([{ role: "assistant", content: "thinking", toolCalls: [{ id: "c1", name: "t", args: {} }] }]);
  expect((out[0]! as any).content.map((b: any) => b.type)).toEqual(["text", "tool_use"]);
});

// Geist gate 2026-09-10 (review, CONFIRMED by a verifier against pi-ai's own
// anthropic adapter, which normalizes for exactly this). The Messages API
// requires tool_use.id to match ^[a-zA-Z0-9_-]+$ and be at most 64 chars. The
// Responses provider persists pi-ai's composite `${call_id}|${item_id}` -- a
// `|`, and an fc_ item id that can run to 400 chars -- and /model or /session
// can carry a session recorded under astra-agent into sonnet. Every later
// request then 400s with no hint that the persisted ids are the cause.
// Normalization must hit BOTH sides of the join identically.
test("anthropic: a Responses-shaped composite id is normalized to the API's pattern on both sides of the join", () => {
  const raw = "call_abc123|fc_" + "x".repeat(400) + "+/=";
  const out = toAnthropicMessages([
    { role: "assistant", content: "", toolCalls: [{ id: raw, name: "read_file", args: {} }] },
    { role: "tool", results: [{ id: raw, name: "read_file", ok: true, output: "A" }] },
  ]);
  const use = (out[0]! as any).content[0];
  const res = (out[1]! as any).content[0];
  expect(use.id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  expect(use.id.startsWith("call_abc123")).toBe(true);   // the unique half survives the cut
  expect(res.tool_use_id).toBe(use.id);
});

test("anthropic: an id that already fits the pattern is passed through unchanged", () => {
  const out = toAnthropicMessages([{ role: "assistant", content: "", toolCalls: [{ id: "toolu_01ABC", name: "t", args: {} }] }]);
  expect((out[0]! as any).content[0].id).toBe("toolu_01ABC");
});

// grep with zero matches and read_file on an empty file both return ok:true with
// output "". The verifier could not confirm the API rejects an empty STRING
// tool_result.content (it does reject an empty text BLOCK); the substitution is
// cheap, tells the model something true, and removes the one case where a
// persisted tool round could poison every later turn of an anthropic session.
test("anthropic: an empty tool output is sent as a stated absence, never as an empty string", () => {
  const out = toAnthropicMessages([
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "grep", args: {} }] },
    { role: "tool", results: [{ id: "c1", name: "grep", ok: true, output: "" }] },
  ]);
  expect((out[1]! as any).content[0].content).toBe("(no output)");
});

// ---------------------------------------------------------------------------
// (6) openai-responses mapping: one tool message EXPANDS to N pi-ai messages.
// ---------------------------------------------------------------------------
test("openai-responses: a tool message expands to one toolResult message per call, joined by id", () => {
  const asst = toPiMessages({ role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", args: { path: "a" } }] }, "m");
  expect(asst).toHaveLength(1);
  expect((asst[0]! as any).content).toEqual([{ type: "toolCall", id: "c1", name: "read_file", arguments: { path: "a" } }]);

  const res = toPiMessages({ role: "tool", results: [
    { id: "c1", name: "read_file", ok: true, output: "A" },
    { id: "c2", name: "read_file", ok: false, output: "boom" },
  ] }, "m");
  expect(res).toHaveLength(2);
  expect(res[0]).toMatchObject({ role: "toolResult", toolCallId: "c1", toolName: "read_file", isError: false });
  expect((res[0]! as any).content).toEqual([{ type: "text", text: "A" }]);
  expect(res[1]).toMatchObject({ toolCallId: "c2", isError: true });
});

test("openai-responses: an assistant message with neither text nor calls maps to nothing", () => {
  expect(toPiMessages({ role: "assistant", content: "" }, "m")).toEqual([]);
});

// ---------------------------------------------------------------------------
// (7) ollama has NO tool-call ids: order is the only join. So a result that is
// merely dropped does not lose one result -- it re-pairs every result after it
// with the wrong call. This arm exists because that failure is silent and
// produces a perfectly well-formed request.
// ---------------------------------------------------------------------------
test("ollama: results keep request order and a failed call still occupies its slot", () => {
  const out = toOllamaMessages([
    { role: "assistant", content: "", toolCalls: [
      { id: "c1", name: "read_file", args: { path: "a" } },
      { id: "c2", name: "write_file", args: { path: "b" } },
      { id: "c3", name: "read_file", args: { path: "c" } },
    ] },
    { role: "tool", results: [
      { id: "c1", name: "read_file", ok: true, output: "A" },
      { id: "c2", name: "write_file", ok: false, output: "denied by user" },
      { id: "c3", name: "read_file", ok: true, output: "C" },
    ] },
  ]);
  expect(out[0]!.tool_calls!.map((c) => c.function.name)).toEqual(["read_file", "write_file", "read_file"]);
  // arguments is an OBJECT on this wire, not a JSON string.
  expect(out[0]!.tool_calls![0]!.function.arguments).toEqual({ path: "a" });
  const results = out.slice(1);
  expect(results.map((m) => m.role)).toEqual(["tool", "tool", "tool"]);
  // The denial holds slot 2. Filtering it would slide "C" onto write_file.
  expect(results.map((m) => m.content)).toEqual(["A", "denied by user", "C"]);
});

// ---------------------------------------------------------------------------
// (7b) THE ARM ABOVE CANNOT TELL A POSITIONAL JOIN FROM AN ID-KEYED ONE, because
// its fixture's ids agree with its array order. Augur measured the same blind
// spot on the wire (2026-09-10, qwen2.5:7b): his single-call probe "could not
// tell 'joins by order' from 'has exactly one slot to join into'", and his arm C
// showed that a CORRECT id, on the exact case where an id exists to
// disambiguate, changes nothing -- the id is inert on this provider.
//
// So this arm makes the two orderings DISAGREE: the results arrive c3, c1, c2 in
// array order while their ids say c1, c2, c3. A mapper that sorted, indexed or
// keyed by id would emit A, B, C and pass the arm above; only a positional
// pass-through emits C, A, B. That is the whole point -- an implementation is
// free to start using the id at any time and nothing else here would notice.
//
// Note the direction, because it is the OPPOSITE of the rule Augur derived for
// his live probe. There, payloads had to be mutually indistinguishable so the
// model could not re-pair them semantically. Here there is no model to exercise
// common sense, and identical payloads would make a swap unobservable: a unit
// arm needs payloads it can tell apart, and ids it CANNOT infer the order from.
// ---------------------------------------------------------------------------
test("ollama: the join is POSITIONAL, not id-keyed -- results follow array order when ids disagree", () => {
  const out = toOllamaMessages([
    { role: "assistant", content: "", toolCalls: [
      { id: "c1", name: "read_file", args: { path: "a" } },
      { id: "c2", name: "read_file", args: { path: "b" } },
      { id: "c3", name: "read_file", args: { path: "c" } },
    ] },
    // Deliberately NOT in id order. An id-keyed mapper reorders to A, B, C.
    { role: "tool", results: [
      { id: "c3", name: "read_file", ok: true, output: "C" },
      { id: "c1", name: "read_file", ok: true, output: "A" },
      { id: "c2", name: "read_file", ok: false, output: "denied by user" },
    ] },
  ]);
  const results = out.slice(1);
  expect(results.map((m) => m.content)).toEqual(["C", "A", "denied by user"]);
  // And the id never reaches the wire at all -- there is no field for it.
  expect(JSON.stringify(results)).not.toContain("c1");
});

test("openai-compat: a tool message expands to one toolResult message per call", () => {
  const res = toCompatMessages({ role: "tool", results: [
    { id: "c1", name: "read_file", ok: true, output: "A" },
    { id: "c2", name: "read_file", ok: false, output: "boom" },
  ] }, "m");
  expect(res).toHaveLength(2);
  expect(res[0]).toMatchObject({ role: "toolResult", toolCallId: "c1", toolName: "read_file", isError: false });
  expect(res[1]).toMatchObject({ toolCallId: "c2", isError: true });
});

// ---------------------------------------------------------------------------
// (9) THE DROP PATH. Augur's arm M, 2026-09-10, qwen2.5:7b, n=3: with the
// MIDDLE of three `read_file` results missing, the model does not report a
// gap -- the positional join slides `c`'s bytes into `b`'s slot and it then
// re-requests `/c.txt`, THE ONE IT ALREADY HAS. The retry loop is aimed away
// from the damage, so it cannot repair it, and the turn finishes holding a
// confidently wrong `b`. An omission is therefore not a degraded error, it is
// strictly worse than one.
//
// The engine already synthesises `ok:false` for a request with no persisted
// result, and arm (4) covers a DENIAL -- but a denial writes a real result
// event, so it never exercises the synthesis. This arm exercises the path
// that does: `replay()` SKIPS lines failing isValidEvent, so a corrupt or
// truncated result line deletes a result while its request survives. Same
// shape reaches here from a failed store append or any future event filter.
//
// SHOWN FIRING: with the `: { ... "no result recorded" }` branch in
// Engine.context() replaced by a `continue`, this arm goes red -- and the
// other THIRTEEN arms in this file stayed green, so the existing battery
// could not see this path at all. It dies on the length assertion (2 results
// for 3 calls), which is BEFORE the wire assertion below, so the rotation
// itself was confirmed separately rather than by that red: feeding
// toOllamaMessages a 3-call round with b's result missing emits two `tool`
// messages, ["111","333"], i.e. slot b carrying c's bytes exactly as Augur
// measured against the live model. Mutation reverted; the branch ships
// unchanged.
// ---------------------------------------------------------------------------
test("a result line dropped by replay still occupies its slot -- no rotation, no silent gap", async () => {
  const store = new SessionStore("thc-9");
  const ws = mkws();
  writeFileSync(join(ws.root, "a.txt"), "111");
  writeFileSync(join(ws.root, "b.txt"), "222");
  writeFileSync(join(ws.root, "c.txt"), "333");
  const deps = { registry: builtinTools(), ws, approvals: mkApprovals(async () => "allow") };

  const p1 = new Scripted([{ toolCalls: [
    { name: "read_file", args: { path: "a.txt" } },
    { name: "read_file", args: { path: "b.txt" } },
    { name: "read_file", args: { path: "c.txt" } },
  ] }, { delta: ["ok"] }]);
  await drain(new Engine({ provider: p1, store, model: "m", tools: deps }).send("read all three"));

  // Corrupt the MIDDLE result in place: `ok` becomes a string, so the line
  // still parses as JSON and is still rejected by isValidEvent -- which is
  // precisely the silent case. The request line is left untouched.
  const lines = readFileSync(store.path, "utf8").split("\n").filter((l) => l.length > 0);
  let hit = 0;
  const patched = lines.map((l) => {
    const o = JSON.parse(l) as Record<string, unknown>;
    if (o.type === "tool_result" && typeof o.output === "string" && o.output.includes("222")) {
      hit++; return JSON.stringify({ ...o, ok: "yes" });
    }
    return l;
  });
  expect(hit).toBe(1);            // the fixture must actually plant the defect
  writeFileSync(store.path, patched.join("\n") + "\n");

  const p2 = new Scripted([{ delta: ["done"] }]);
  await drain(new Engine({ provider: p2, store: new SessionStore("thc-9"), model: "m", tools: deps }).send("again"));

  const msgs = p2.calls[0]!;
  const asst = msgs.find((m) => m.role === "assistant" && (m as any).toolCalls?.length) as Extract<ChatMessage, { role: "assistant" }>;
  const tool = msgs.find((m) => m.role === "tool") as Extract<ChatMessage, { role: "tool" }>;
  expect(asst.toolCalls).toHaveLength(3);
  // The invariant that makes the rotation impossible: one result per call,
  // always, whatever replay handed us.
  expect(tool.results).toHaveLength(3);
  expect(tool.results.map((r) => r.ok)).toEqual([true, false, true]);
  expect(tool.results[0]!.output).toContain("111");
  expect(tool.results[1]!.output).toContain("no result recorded");
  expect(tool.results[2]!.output).toContain("333");

  // And on the wire, where the join is positional and nothing can repair it:
  // slot b must NOT carry c's bytes.
  const wire = toOllamaMessages([asst, tool]);
  const toolMsgs = wire.filter((m) => m.role === "tool");
  expect(toolMsgs).toHaveLength(3);
  expect(toolMsgs[1]!.content).not.toContain("333");
});

// ---------------------------------------------------------------------------
// (10) Geist gate 2026-09-10 -- two review angles independently found this.
// requestId is the PROVIDER's tool-call id, unique per response at best; several
// openai-compat servers and local tool parsers emit per-response counters
// (call_0, call_1) that restart every round. A result map keyed by bare
// requestId across the whole log is last-write-wins, so round 0's call was
// answered with round 1's output -- a fabricated transcript, well-formed on
// every wire, the exact class this contract exists to end. Pairing is by LOG
// POSITION: a result answers the nearest preceding unanswered request with
// its id.
// ---------------------------------------------------------------------------
test("colliding request ids across rounds pair by log position, not last-write-wins", async () => {
  const store = new SessionStore("thc-10");
  const ws = mkws();
  writeFileSync(join(ws.root, "a.txt"), "111");
  writeFileSync(join(ws.root, "b.txt"), "222");
  const deps = { registry: builtinTools(), ws, approvals: mkApprovals(async () => "allow") };

  const p1 = new Scripted([
    { toolCalls: [{ id: "call_0", name: "read_file", args: { path: "a.txt" } }] },
    { toolCalls: [{ id: "call_0", name: "read_file", args: { path: "b.txt" } }] },
    { delta: ["ok"] },
  ]);
  await drain(new Engine({ provider: p1, store, model: "m", tools: deps }).send("read both"));

  const p2 = new Scripted([{ delta: ["done"] }]);
  await drain(new Engine({ provider: p2, store: new SessionStore("thc-10"), model: "m", tools: deps }).send("again"));

  const tools = p2.calls[0]!.filter((m) => m.role === "tool") as Extract<ChatMessage, { role: "tool" }>[];
  expect(tools).toHaveLength(2);
  expect(tools[0]!.results[0]!.output).toContain("111");
  expect(tools[0]!.results[0]!.output).not.toContain("222");
  expect(tools[1]!.results[0]!.output).toContain("222");
});

// ---------------------------------------------------------------------------
// (11) The mirror of arm (9): the REQUEST line is the one lost, the result line
// is intact. Pairing only what a surviving request reaches would drop the
// result silently -- and a dropped write_file/run_command result is the model
// losing the evidence that a side effect already happened, then doing it
// again. The old pre-contract replay at least kept the output visible. An
// orphan cannot be replayed as an assistant call (no record of one was made --
// inventing it is the fabrication this contract forbids), so it replays as a
// user-role note that says exactly what it is.
// ---------------------------------------------------------------------------
test("a tool_result whose request line was lost still reaches the transcript, marked as recovered", async () => {
  const store = new SessionStore("thc-11");
  const ws = mkws();
  writeFileSync(join(ws.root, "a.txt"), "111");
  const deps = { registry: builtinTools(), ws, approvals: mkApprovals(async () => "allow") };

  const p1 = new Scripted([{ toolCalls: [{ name: "read_file", args: { path: "a.txt" } }] }, { delta: ["ok"] }]);
  await drain(new Engine({ provider: p1, store, model: "m", tools: deps }).send("read it"));

  const lines = readFileSync(store.path, "utf8").split("\n").filter((l) => l.length > 0);
  let hit = 0;
  const patched = lines.map((l) => {
    const o = JSON.parse(l) as Record<string, unknown>;
    if (o.type === "tool_request") { hit++; return JSON.stringify({ ...o, argsHash: 7 }); } // still JSON, rejected by isValidEvent
    return l;
  });
  expect(hit).toBe(1);
  writeFileSync(store.path, patched.join("\n") + "\n");

  const p2 = new Scripted([{ delta: ["done"] }]);
  await drain(new Engine({ provider: p2, store: new SessionStore("thc-11"), model: "m", tools: deps }).send("again"));

  const msgs = p2.calls[0]!;
  expect(msgs.find((m) => m.role === "tool")).toBeUndefined();          // no request survived: nothing to pair
  expect(msgs.find((m) => m.role === "assistant" && (m as any).toolCalls?.length)).toBeUndefined(); // and no call is invented
  const note = msgs.find((m) => m.role === "user" && m.content.includes("111"));
  expect(note).toBeDefined();
  expect((note as any).content).toContain("recovered tool_result read_file");
});
