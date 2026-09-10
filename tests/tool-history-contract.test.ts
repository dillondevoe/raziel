import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
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
  constructor(private rounds: { delta?: string[]; toolCalls?: { name: string; args: unknown }[] }[]) {}
  async *stream(opts: { messages: ChatMessage[]; signal?: AbortSignal } & Record<string, any>): AsyncIterable<StreamChunk> {
    this.calls.push(opts.messages);
    const round = this.rounds[Math.min(this.i, this.rounds.length - 1)]!;
    this.i++;
    for (const t of round.delta ?? []) yield { type: "delta", text: t };
    for (const tc of round.toolCalls ?? []) yield { type: "tool_call", id: crypto.randomUUID(), name: tc.name, args: tc.args };
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

test("openai-compat: a tool message expands to one toolResult message per call", () => {
  const res = toCompatMessages({ role: "tool", results: [
    { id: "c1", name: "read_file", ok: true, output: "A" },
    { id: "c2", name: "read_file", ok: false, output: "boom" },
  ] }, "m");
  expect(res).toHaveLength(2);
  expect(res[0]).toMatchObject({ role: "toolResult", toolCallId: "c1", toolName: "read_file", isError: false });
  expect(res[1]).toMatchObject({ toolCallId: "c2", isError: true });
});
