// The three follow-ups PR #20 left: Ctrl-C stops a running tool, the engine
// caps every tool result as a backstop, and rules.json is written owner-only.
// No network: fetch is injected; the long-running child is `sleep`.
import { test, expect, beforeEach } from "bun:test";
import { chmodSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine";
import { SessionStore, razielHome } from "../src/session";
import { Workspace } from "../src/tools/workspace";
import { Rules } from "../src/rules";
import { ApprovalManager } from "../src/approvals";
import { builtinTools } from "../src/tools/registry";
import { runCommandTool } from "../src/tools/exec";
import { fetchTool } from "../src/tools/fetch";
import { capResult } from "../src/engine_tool_call";
import type { BuiltinTool } from "../src/tools/files";
import type { ChatMessage, Provider, StreamChunk } from "../src/provider";

beforeEach(() => { process.env.RAZIEL_HOME = mkdtempSync(join(tmpdir(), "raziel-int-")); });

const mkws = () => new Workspace(mkdtempSync(join(tmpdir(), "raziel-int-ws-")));
const MARKER = "…[truncated]";

/** Round 0 makes one tool call; any later round replies "never". */
class OneCall implements Provider {
  readonly name = "one-call";
  seen: ChatMessage[][] = [];
  constructor(private call: { name: string; args: unknown }) {}
  async *stream(o: { messages: ChatMessage[] }): AsyncIterable<StreamChunk> {
    this.seen.push(o.messages);
    if (this.seen.length === 1) yield { type: "tool_call", id: "c1", name: this.call.name, args: this.call.args };
    else yield { type: "delta", text: "never" };
    yield { type: "done", stopReason: "end" };
  }
}

function setup(call: { name: string; args: unknown }, registry: Map<string, BuiltinTool> = builtinTools()) {
  const store = new SessionStore();
  const provider = new OneCall(call);
  const rulesPath = join(mkdtempSync(join(tmpdir(), "raziel-int-rules-")), "rules.json");
  const approvals = new ApprovalManager(Rules.load(rulesPath), { ask: async () => "allow", write: () => {} }, rulesPath);
  const engine = new Engine({ provider, store, model: "m", tools: { registry, ws: mkws(), approvals } });
  return { store, provider, engine };
}

const results = (store: SessionStore) => store.replay().filter((e) => e.type === "tool_result") as any[];
const stops = (store: SessionStore) => store.replay().filter((e) => e.type === "turn_end").map((e: any) => e.stop);

// --- (a) Ctrl-C reaches the running tool ---------------------------------

test("run_command: Ctrl-C kills the child at once and the result says it was interrupted", async () => {
  const ctl = new AbortController();
  const t0 = Date.now();
  setTimeout(() => ctl.abort(), 100);
  const r = await runCommandTool.run({ argv: ["sleep", "10"] }, mkws(), ctl.signal);
  expect(Date.now() - t0).toBeLessThan(3_000);
  expect(r.ok).toBe(false);
  expect(r.output.startsWith("run_command: interrupted (Ctrl-C); killed")).toBe(true);
});

test("run_command: a signal already aborted means the command never starts", async () => {
  const ws = mkws();
  const r = await runCommandTool.run({ argv: ["touch", "should-not-exist"] }, ws, AbortSignal.abort());
  expect(r).toEqual({ ok: false, output: "run_command: interrupted (Ctrl-C) before it started" });
  expect(await Bun.file(join(ws.root, "should-not-exist")).exists()).toBe(false);
});

test("fetch: Ctrl-C aborts a request that never answers, well before the 30 s timeout (injected fetch)", async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = ((_u: string, init?: RequestInit) => new Promise((_res, rej) => {
    init?.signal?.addEventListener("abort", () => rej(init.signal!.reason));
  })) as any;
  try {
    const ctl = new AbortController();
    const t0 = Date.now();
    setTimeout(() => ctl.abort(), 50);
    const r = await fetchTool.run({ url: "https://example.invalid/" }, mkws(), ctl.signal);
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(r).toEqual({ ok: false, output: "fetch: interrupted (Ctrl-C)" });
  } finally { globalThis.fetch = savedFetch; }
});

test("engine: Ctrl-C during run_command kills it, records 'interrupted', ends the turn 'interrupt', no re-stream", async () => {
  const ctl = new AbortController();
  const { store, provider, engine } = setup({ name: "run_command", args: { argv: ["sleep", "10"] } });
  const t0 = Date.now();
  for await (const e of engine.send("go", { signal: ctl.signal })) {
    if (e.type === "approval_decision") setTimeout(() => ctl.abort(), 150);
  }
  expect(Date.now() - t0).toBeLessThan(5_000);
  expect(results(store)).toHaveLength(1);
  expect(results(store)[0].ok).toBe(false);
  expect(results(store)[0].output).toContain("interrupted (Ctrl-C)");
  expect(provider.seen).toHaveLength(1);
  expect(stops(store)).toEqual(["interrupt"]);
});

// --- (b) engine-level cap on every tool result ---------------------------

test("engine caps an uncapped tool's result at 64,000 chars with the marker", async () => {
  const reg = builtinTools();
  reg.set("read_file", { spec: reg.get("read_file")!.spec, run: async () => ({ ok: true, output: "z".repeat(200_000) }) });
  const s = setup({ name: "read_file", args: { path: "a.txt" } }, reg);
  for await (const _ of s.engine.send("go")) { /* drain */ }
  expect(results(s.store)[0]).toMatchObject({ ok: true, output: "z".repeat(64_000) + MARKER });
});

test("engine cap leaves a built-in's own capped output untouched (marker plus a trailing notice)", () => {
  const ownCapped = "x".repeat(64_000) + MARKER + "\n[truncated: searched 200 files; narrow path]";
  expect(capResult(ownCapped)).toBe(ownCapped);
  const fetched = "[UNTRUSTED FETCHED CONTENT]\n" + "y".repeat(64_000) + MARKER;
  expect(capResult(fetched)).toBe(fetched);
  expect(capResult("short")).toBe("short");
});

test("engine caps a thrown tool error message too", async () => {
  const reg = builtinTools();
  reg.set("read_file", { spec: reg.get("read_file")!.spec, run: async () => { throw new Error("e".repeat(100_000)); } });
  const s = setup({ name: "read_file", args: { path: "a.txt" } }, reg);
  for await (const _ of s.engine.send("go")) { /* drain */ }
  expect(results(s.store)[0]).toMatchObject({ ok: false, output: "e".repeat(64_000) + MARKER });
});

// --- (c) rules.json is owner-only ----------------------------------------

const mode = (p: string) => statSync(p).mode & 0o777;

test("rules.json is written 0600 and a directory it creates is 0700 (tmp RAZIEL_HOME)", () => {
  const path = join(razielHome(), "nested", "rules.json");
  const rules = Rules.load(path);
  rules.add({ tool: "read_file", pattern: '{"path":"a.txt"}' });
  rules.save(path);
  expect(mode(path)).toBe(0o600);
  expect(mode(join(razielHome(), "nested"))).toBe(0o700);
  expect(Rules.load(path).list()).toEqual([{ tool: "read_file", pattern: '{"path":"a.txt"}' }]);
});

test("saving over an older world-readable rules.json leaves it 0600", () => {
  const path = join(razielHome(), "rules.json");
  writeFileSync(path, "[]");
  chmodSync(path, 0o644);
  const rules = Rules.load(path);
  rules.add({ tool: "grep", pattern: '{"pattern":"x"}' });
  rules.save(path);
  expect(mode(path)).toBe(0o600);
});
