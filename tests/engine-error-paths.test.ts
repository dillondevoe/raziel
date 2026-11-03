// What a user sees when something goes wrong AFTER the first turn works:
// a tool throws, times out or returns too much, the model emits a malformed
// call, the round budget runs out, an approval is refused, the provider
// stream dies mid-turn, or Ctrl-C lands while a tool is running. Each test
// asserts the session log, the plain-REPL output, and that the session lives.
import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine";
import { SessionStore } from "../src/session";
import { Workspace } from "../src/tools/workspace";
import { Rules } from "../src/rules";
import { ApprovalManager } from "../src/approvals";
import { parseGrant } from "../src/grant";
import { runRepl } from "../src/cli";
import { builtinTools } from "../src/tools/registry";
import { execLimits, runCommandTool } from "../src/tools/exec";
import { fetchLimits, fetchTool } from "../src/tools/fetch";
import { grepTool, globTool } from "../src/tools/search";
import type { BuiltinTool } from "../src/tools/files";
import type { ChatMessage, Provider, StreamChunk } from "../src/provider";

beforeEach(() => { process.env.RAZIEL_HOME = mkdtempSync(join(tmpdir(), "raziel-err-")); });

const mkws = () => new Workspace(mkdtempSync(join(tmpdir(), "raziel-err-ws-")));

function mkApprovals(ask: () => Promise<"allow" | "deny" | "always"> = async () => "allow", grant?: string) {
  const rulesPath = join(mkdtempSync(join(tmpdir(), "raziel-err-rules-")), "rules.json");
  const notes: string[] = [];
  const am = new ApprovalManager(Rules.load(rulesPath), { ask, write: (s) => notes.push(s) }, rulesPath,
    grant === undefined ? undefined : parseGrant(grant, []));
  return { am, notes };
}

type Round = { delta?: string[]; calls?: { name: string; args: unknown }[]; throwAfter?: string };

/** Round i plays script[i] (last one repeats). `throwAfter` kills the stream
 * after its deltas, the way a dropped connection or a bad tool JSON does. */
class Scripted implements Provider {
  readonly name = "scripted";
  seen: ChatMessage[][] = [];
  private i = 0;
  constructor(private script: Round[]) {}
  async *stream(o: { messages: ChatMessage[]; signal?: AbortSignal }): AsyncIterable<StreamChunk> {
    this.seen.push(o.messages);
    const r = this.script[Math.min(this.i++, this.script.length - 1)]!;
    for (const text of r.delta ?? []) yield { type: "delta", text };
    if (r.throwAfter) throw new Error(r.throwAfter);
    for (const c of r.calls ?? []) yield { type: "tool_call", id: crypto.randomUUID(), name: c.name, args: c.args };
    yield { type: "done", stopReason: "end" };
  }
}

function setup(script: Round[], opts: { registry?: Map<string, BuiltinTool>; ask?: () => Promise<"allow" | "deny" | "always">; grant?: string; maxRounds?: number } = {}) {
  const store = new SessionStore();
  const ws = mkws();
  const provider = new Scripted(script);
  const { am, notes } = mkApprovals(opts.ask, opts.grant);
  const engine = new Engine({ provider, store, model: "m", maxRounds: opts.maxRounds,
    tools: { registry: opts.registry ?? builtinTools(), ws, approvals: am } });
  return { store, ws, provider, engine, notes };
}

async function* lines(...xs: string[]) { for (const x of xs) yield x; }

async function repl(engine: Engine, ...input: string[]): Promise<string> {
  let out = "";
  await runRepl({ engine: { current: engine }, input: lines(...input), write: (s) => { out += s; } });
  return out;
}

const types = (store: SessionStore) => store.replay().map((e) => e.type);
const results = (store: SessionStore) => store.replay().filter((e) => e.type === "tool_result") as any[];
const stops = (store: SessionStore) => store.replay().filter((e) => e.type === "turn_end").map((e: any) => e.stop);
const noStack = (out: string) => expect(out).not.toMatch(/\n\s+at .+:\d+/);

function withTool(name: string, run: BuiltinTool["run"]): Map<string, BuiltinTool> {
  const reg = builtinTools();
  reg.set(name, { spec: { ...reg.get(name)!.spec }, run });
  return reg;
}

test("a tool that throws: ok:false result carrying the message, model reads it, turn ends cleanly, no stack trace", async () => {
  const reg = withTool("read_file", async () => { throw new Error("disk on fire"); });
  const { store, provider, engine } = setup([{ calls: [{ name: "read_file", args: { path: "a.txt" } }] }, { delta: ["it failed"] }], { registry: reg });
  const out = await repl(engine, "read a.txt", "still there?");
  expect(results(store)[0]).toMatchObject({ ok: false, output: "disk on fire" });
  expect(out).toContain("it failed");
  noStack(out);
  // The model saw the failure as a tool result, not as silence.
  const toolMsg = provider.seen[1]!.find((m) => m.role === "tool") as any;
  expect(toolMsg.results[0]).toMatchObject({ ok: false, output: "disk on fire" });
  // Session alive: the second line ran as its own turn.
  expect(stops(store)).toEqual(["end", "end"]);
});

test("a tool that throws a non-Error value is still recorded as a failed result", async () => {
  const reg = withTool("read_file", async () => { throw "plain string"; });
  const { store, engine } = setup([{ calls: [{ name: "read_file", args: { path: "a.txt" } }] }, { delta: ["ok"] }], { registry: reg });
  await repl(engine, "go");
  expect(results(store)[0]).toMatchObject({ ok: false, output: "plain string" });
});

test("run_command past its timeout is killed and says it timed out (not a bare exit code)", async () => {
  const saved = execLimits.timeoutMs;
  execLimits.timeoutMs = 100;
  try {
    const t0 = Date.now();
    const r = await runCommandTool.run({ argv: ["sleep", "5"] }, mkws());
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r.ok).toBe(false);
    expect(r.output).toStartWith("run_command: timed out after 100 ms; killed");
  } finally { execLimits.timeoutMs = saved; }
});

test("fetch that never answers times out with a plain message instead of hanging the turn (injected fetch)", async () => {
  const savedFetch = globalThis.fetch;
  const savedMs = fetchLimits.timeoutMs;
  fetchLimits.timeoutMs = 50;
  globalThis.fetch = ((_u: string, init?: RequestInit) => new Promise((_res, rej) => {
    init?.signal?.addEventListener("abort", () => rej(init.signal!.reason));
  })) as any;
  try {
    expect(await fetchTool.run({ url: "https://example.invalid/" }, mkws())).toEqual({ ok: false, output: "fetch: timed out after 50 ms" });
  } finally { globalThis.fetch = savedFetch; fetchLimits.timeoutMs = savedMs; }
});

test("fetch passes a body through when the injected fetch answers in time", async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("hello")) as any;
  try {
    expect(await fetchTool.run({ url: "https://example.invalid/" }, mkws())).toEqual({ ok: true, output: "[UNTRUSTED FETCHED CONTENT]\nhello" });
  } finally { globalThis.fetch = savedFetch; }
});

test("oversized results are capped at 64,000 chars with a marker: run_command, grep, glob", async () => {
  const ws = mkws();
  const exec = await runCommandTool.run({ argv: [process.execPath, "-e", "process.stdout.write('0'.repeat(70000))"] }, ws);
  expect(exec.output.endsWith("…[truncated]")).toBe(true);
  expect(exec.output.length).toBe(64_000 + "…[truncated]".length);

  writeFileSync(join(ws.root, "big.txt"), "x".repeat(70_000));
  const grep = await grepTool.run({ pattern: "x" }, ws);
  expect(grep.ok).toBe(true);
  expect(grep.output.length).toBe(64_000 + "…[truncated]".length);

  for (let i = 0; i < 1800; i++) writeFileSync(join(ws.root, `file-with-a-long-enough-name-${String(i).padStart(4, "0")}.md`), "");
  const glob = await globTool.run({ pattern: "*.md" }, ws);
  expect(glob.ok).toBe(true);
  expect(glob.output.endsWith("…[truncated]")).toBe(true);
});

test("grep's truncation notices survive the output cap", async () => {
  const ws = mkws();
  for (let i = 0; i < 201; i++) writeFileSync(join(ws.root, `${i}.txt`), "y".repeat(400));
  const r = await grepTool.run({ pattern: "y" }, ws);
  expect(r.output).toContain("…[truncated]");
  expect(r.output.endsWith("[truncated: searched 200 files; narrow path]")).toBe(true);
});

test("malformed tool JSON from the provider: error printed, turn ends 'error', nothing runs, next turn works", async () => {
  const { store, engine } = setup([
    { delta: ["let me look"], throwAfter: "openai-compat: invalid tool JSON" },
    { delta: ["fine now"] },
  ]);
  const out = await repl(engine, "look", "again");
  expect(out).toContain("[error] openai-compat: invalid tool JSON");
  noStack(out);
  expect(types(store)).not.toContain("tool_request");
  // The half-streamed "let me look" is not persisted as a reply.
  const replies = store.replay().filter((e) => e.type === "assistant_message").map((e: any) => e.text);
  expect(replies).toEqual(["fine now"]);
  expect(stops(store)).toEqual(["error", "end"]);
});

test("malformed tool args (not an object): refused without asking, and the log says why, not 'denied by user'", async () => {
  let asked = 0;
  const { store, engine } = setup([{ calls: [{ name: "write_file", args: "path=a.txt" }] }, { delta: ["ok"] }],
    { ask: async () => { asked++; return "allow"; } });
  await repl(engine, "write");
  expect(asked).toBe(0);
  const r = results(store)[0];
  expect(r.ok).toBe(false);
  expect(r.output).toStartWith("denied: critical risk, refused without asking");
  expect(r.output).not.toContain("by user");
});

test("round budget spent: '[error] tool round limit' is printed, the answer pass still replies, session continues", async () => {
  const { store, provider, engine } = setup([
    { calls: [{ name: "glob", args: { pattern: "*" } }] },
    { calls: [{ name: "glob", args: { pattern: "*" } }] },
    { delta: ["summary"] },
    { delta: ["next turn"] },
  ], { maxRounds: 2 });
  const out = await repl(engine, "loop", "again");
  expect(out).toContain("[error] tool round limit");
  expect(out).toContain("summary");
  expect(out).toContain("next turn");
  expect(provider.seen).toHaveLength(4);
  expect(stops(store)).toEqual(["end", "end"]);
});

test("a grant refusal is logged as the grant's refusal, not as a user's", async () => {
  const { store, engine, notes } = setup([{ calls: [{ name: "write_file", args: { path: "a.txt", content: "x" } }] }, { delta: ["ok"] }],
    { grant: "read" });
  await repl(engine, "write");
  expect(results(store)[0].output).toBe("denied: outside grant (grant: read; run: (none))");
  expect(notes.join("")).toContain("outside grant");
});

test("an interactive deny is still recorded as 'denied by user' and the turn continues", async () => {
  const { store, engine } = setup([{ calls: [{ name: "write_file", args: { path: "a.txt", content: "x" } }] }, { delta: ["understood"] }],
    { ask: async () => "deny" });
  const out = await repl(engine, "write");
  expect(results(store)[0]).toMatchObject({ ok: false, output: "denied by user" });
  expect(out).toContain("understood");
});

test("provider stream dies after a tool ran: result kept, error printed, no half reply saved, next turn replays the round", async () => {
  const { ws, store, provider, engine } = setup([
    { calls: [{ name: "read_file", args: { path: "a.txt" } }] },
    { delta: ["half a sen"], throwAfter: "socket hang up" },
    { delta: ["recovered"] },
  ]);
  writeFileSync(join(ws.root, "a.txt"), "contents");
  const out = await repl(engine, "read", "go on");
  expect(out).toContain("[error] socket hang up");
  noStack(out);
  expect(results(store)[0]).toMatchObject({ ok: true, output: "contents" });
  expect(store.replay().filter((e) => e.type === "assistant_message").map((e: any) => e.text)).toEqual(["recovered"]);
  expect(stops(store)).toEqual(["error", "end"]);
  // The third call (second turn) still sees the tool round it already paid for.
  const ctx = provider.seen[2]!;
  expect(ctx.some((m) => m.role === "tool" && m.results[0]!.output === "contents")).toBe(true);
  expect(ctx.at(-1)).toEqual({ role: "user", content: "go on" });
});

function slowTool(ctl: AbortController): Map<string, BuiltinTool> {
  return withTool("read_file", async () => { ctl.abort(); await Bun.sleep(20); return { ok: true, output: "finished anyway" }; });
}

test("Ctrl-C while a tool runs: the tool finishes, its result is recorded, the turn ends 'interrupt', no re-stream", async () => {
  const ctl = new AbortController();
  const { store, provider, engine } = setup([{ calls: [{ name: "read_file", args: { path: "a.txt" } }] }, { delta: ["never"] }],
    { registry: slowTool(ctl) });
  for await (const _ of engine.send("go", { signal: ctl.signal })) { /* drain */ }
  expect(results(store)[0]).toMatchObject({ ok: true, output: "finished anyway" });
  expect(provider.seen).toHaveLength(1);
  expect(stops(store)).toEqual(["interrupt"]);
});

test("Ctrl-C during the LAST allowed round's tool ends 'interrupt', not a round-limit error and an 'end'", async () => {
  const ctl = new AbortController();
  const { store, provider, engine } = setup([{ calls: [{ name: "read_file", args: { path: "a.txt" } }] }, { delta: ["never"] }],
    { registry: slowTool(ctl), maxRounds: 1 });
  for await (const _ of engine.send("go", { signal: ctl.signal })) { /* drain */ }
  expect(types(store)).not.toContain("error");
  expect(types(store)).not.toContain("assistant_message");
  expect(provider.seen).toHaveLength(1);
  expect(stops(store)).toEqual(["interrupt"]);
});
