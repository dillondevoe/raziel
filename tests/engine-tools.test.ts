import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine";
import { SessionStore } from "../src/session";
import { Workspace } from "../src/tools/workspace";
import { Rules } from "../src/rules";
import { ApprovalManager } from "../src/approvals";
import { builtinTools, toolSpecs, sliceTools } from "../src/tools/registry";
import { writeFileTool } from "../src/tools/files";
import type { BuiltinTool } from "../src/tools/files";
import type { ChatMessage, Provider, StreamChunk } from "../src/provider";
import { getProfile } from "../src/profiles";

beforeEach(() => { process.env.RAZIEL_HOME = mkdtempSync(join(tmpdir(), "raziel-test-")); });

async function drain(it: AsyncIterable<{ type: string }>) {
  const out: any[] = []; for await (const e of it) out.push(e); return out;
}

function mkws(): Workspace {
  return new Workspace(mkdtempSync(join(tmpdir(), "raziel-tools-ws-")));
}

function mkApprovals(ask: (card: string, risk: string) => Promise<"allow" | "deny" | "always">): ApprovalManager {
  const rulesPath = join(mkdtempSync(join(tmpdir(), "raziel-tools-rules-")), "rules.json");
  return new ApprovalManager(Rules.load(rulesPath), { ask: ask as any }, rulesPath);
}

/** A test-local provider giving full per-round control: round i yields the
 * i-th script entry's delta text then tool calls (index clamped, so the
 * last entry repeats forever — deliberately used for the round-limit test). */
class ScriptedToolProvider implements Provider {
  readonly name = "scripted";
  calls: ChatMessage[][] = [];
  toolsLog: unknown[] = [];
  private i = 0;
  constructor(private rounds: { delta?: string[]; toolCalls?: { name: string; args: unknown }[] }[]) {}

  async *stream(opts: {
    model: string; system?: string; messages: ChatMessage[]; signal?: AbortSignal;
    sampling?: unknown; contextTokens?: number; tools?: unknown;
  }): AsyncIterable<StreamChunk> {
    this.calls.push(opts.messages);
    this.toolsLog.push(opts.tools);
    const round = this.rounds[Math.min(this.i, this.rounds.length - 1)]!;
    this.i++;
    for (const text of round.delta ?? []) {
      if (opts.signal?.aborted) return;
      yield { type: "delta", text };
    }
    for (const tc of round.toolCalls ?? []) {
      if (opts.signal?.aborted) return;
      yield { type: "tool_call", id: crypto.randomUUID(), name: tc.name, args: tc.args };
    }
    if (!opts.signal?.aborted) yield { type: "done", stopReason: "end" };
  }
}

test("registry: builtinTools has all 7 in insertion order; toolSpecs maps to specs", () => {
  const registry = builtinTools();
  expect([...registry.keys()]).toEqual([
    "read_file", "write_file", "edit_file", "grep", "glob", "run_command", "fetch",
  ]);
  const specs = toolSpecs(registry);
  expect(specs.map((s) => s.name)).toEqual([...registry.keys()]);
});

// --- Fix round (I1): profile maxToolSurface enforcement ------------------

test("sliceTools: takes the first N entries in insertion order", () => {
  const registry = builtinTools();
  const sliced = sliceTools(registry, 3);
  expect([...sliced.keys()]).toEqual(["read_file", "write_file", "edit_file"]);
});

test("an Engine built with the qwen profile's sliced registry advertises exactly 6 tool specs", async () => {
  const store = new SessionStore("slice-qwen");
  const ws = mkws();
  const qwen = getProfile("qwen")!;
  expect(qwen.maxToolSurface).toBe(6);
  const registry = sliceTools(builtinTools(), qwen.maxToolSurface);
  const approvals = mkApprovals(async () => "allow");
  const provider = new ScriptedToolProvider([{ delta: ["hi"] }]);

  const eng = new Engine({ provider, store, model: "m", tools: { registry, ws, approvals } });
  await drain(eng.send("hi"));

  expect((provider.toolsLog[0] as any[]).length).toBe(6);
});

test("single tool round: read_file executes, exact event sequence, tool_result carries file content", async () => {
  const store = new SessionStore("t1");
  const ws = mkws();
  writeFileSync(join(ws.root, "hello.txt"), "hello world");
  const registry = builtinTools();
  const approvals = mkApprovals(async () => "allow");
  const provider = new ScriptedToolProvider([
    { toolCalls: [{ name: "read_file", args: { path: "hello.txt" } }] },
    { delta: ["done"] },
  ]);

  const eng = new Engine({ provider, store, model: "m", tools: { registry, ws, approvals } });
  await drain(eng.send("read the file"));

  const replayed = store.replay();
  expect(replayed.map((e) => e.type)).toEqual([
    "user_message", "tool_request", "approval_request", "approval_decision",
    "tool_result", "assistant_message", "turn_end",
  ]);
  const tr = replayed.find((e) => e.type === "tool_result") as any;
  expect(tr.ok).toBe(true);
  expect(tr.output).toContain("hello world");
  expect((replayed.at(-1) as any).stop).toBe("end");
  // tools were actually advertised to the provider
  expect((provider.toolsLog[0] as any[]).map((s: any) => s.name)).toContain("read_file");
});

test("deny: tool never runs, tool_result says 'denied by user'", async () => {
  const store = new SessionStore("t2");
  const ws = mkws();
  let ran = 0;
  const spyWrite: BuiltinTool = {
    spec: writeFileTool.spec,
    async run(args, w) { ran++; return writeFileTool.run(args, w); },
  };
  const registry = builtinTools();
  registry.set("write_file", spyWrite);
  let askCalls = 0;
  const approvals = mkApprovals(async () => { askCalls++; return "deny"; });
  const provider = new ScriptedToolProvider([
    { toolCalls: [{ name: "write_file", args: { path: "x.txt", content: "hi" } }] },
    { delta: ["ok"] },
  ]);

  const eng = new Engine({ provider, store, model: "m", tools: { registry, ws, approvals } });
  await drain(eng.send("write it"));

  expect(ran).toBe(0);
  expect(askCalls).toBe(1);
  const tr = store.replay().find((e) => e.type === "tool_result") as any;
  expect(tr.ok).toBe(false);
  expect(tr.output).toBe("denied by user");
  const dec = store.replay().find((e) => e.type === "approval_decision") as any;
  expect(dec.decision).toBe("deny");
});

test("unknown tool (recognized by risk classing but absent from the registry map): ok:false 'unknown tool', no throw", async () => {
  const store = new SessionStore("t3");
  const ws = mkws();
  writeFileSync(join(ws.root, "note.txt"), "hi");
  const registry = builtinTools();
  registry.delete("read_file"); // risk still classes it fine; execution finds it missing
  const approvals = mkApprovals(async () => "allow");
  const provider = new ScriptedToolProvider([
    { toolCalls: [{ name: "read_file", args: { path: "note.txt" } }] },
    { delta: ["ok"] },
  ]);

  const eng = new Engine({ provider, store, model: "m", tools: { registry, ws, approvals } });
  const events = await drain(eng.send("go"));
  expect(events.some((e) => e.type === "error")).toBe(false); // never throws, no engine-level error event either

  const tr = store.replay().find((e) => e.type === "tool_result") as any;
  expect(tr.ok).toBe(false);
  expect(tr.output).toBe("unknown tool");
});

test("a provider that yields tool_calls forever stops at 8 rounds with a 'tool round limit' error, finish('end')", async () => {
  const store = new SessionStore("t4");
  const ws = mkws();
  writeFileSync(join(ws.root, "loop.txt"), "x");
  const registry = builtinTools();
  const approvals = mkApprovals(async () => "allow");
  const provider = new ScriptedToolProvider([
    { toolCalls: [{ name: "read_file", args: { path: "loop.txt" } }] },
  ]);

  const eng = new Engine({ provider, store, model: "m", tools: { registry, ws, approvals } });
  await drain(eng.send("go"));

  const replayed = store.replay();
  expect(replayed.filter((e) => e.type === "tool_result").length).toBe(8);
  const errors = replayed.filter((e) => e.type === "error") as any[];
  expect(errors.some((e) => e.message === "tool round limit")).toBe(true);
  const last = replayed.at(-1) as any;
  expect(last.type).toBe("turn_end");
  expect(last.stop).toBe("end");
});

test("argsHash mismatch (decide's returned hash doesn't match args about to execute) refuses without running (R10)", async () => {
  const store = new SessionStore("t5");
  const ws = mkws();
  let ran = 0;
  const spyWrite: BuiltinTool = {
    spec: writeFileTool.spec,
    async run(args, w) { ran++; return writeFileTool.run(args, w); },
  };
  const registry = builtinTools();
  registry.set("write_file", spyWrite);
  const approvals = mkApprovals(async () => "allow");
  // Monkeypatch: decide still says "allow" but returns a hash that can never
  // match argsHash(tool, args) for the real args about to execute.
  (approvals as any).decide = async () => ({ decision: "allow", argsHash: "0".repeat(64) });

  const provider = new ScriptedToolProvider([
    { toolCalls: [{ name: "write_file", args: { path: "x.txt", content: "hi" } }] },
    { delta: ["ok"] },
  ]);

  const eng = new Engine({ provider, store, model: "m", tools: { registry, ws, approvals } });
  await drain(eng.send("go"));

  expect(ran).toBe(0);
  const tr = store.replay().find((e) => e.type === "tool_result") as any;
  expect(tr.ok).toBe(false);
  expect(tr.output).toBe("argsHash mismatch — refusing");
});

test("context() replays tool_result events as '[tool_result <tool>] <output>' user messages on later turns", async () => {
  const store = new SessionStore("t6");
  const ws = mkws();
  writeFileSync(join(ws.root, "note.txt"), "the answer is 42");
  const registry = builtinTools();
  const approvals = mkApprovals(async () => "allow");

  const provider1 = new ScriptedToolProvider([
    { toolCalls: [{ name: "read_file", args: { path: "note.txt" } }] },
    { delta: ["ok"] },
  ]);
  const eng1 = new Engine({ provider: provider1, store, model: "m", tools: { registry, ws, approvals } });
  await drain(eng1.send("read it"));

  const provider2 = new ScriptedToolProvider([{ delta: ["done"] }]);
  const eng2 = new Engine({ provider: provider2, store, model: "m", tools: { registry, ws, approvals } });
  await drain(eng2.send("what did it say?"));

  const secondMessages = provider2.calls[0]!;
  const toolMsg = secondMessages.find((m) => m.content.startsWith("[tool_result read_file]"));
  expect(toolMsg).toBeDefined();
  expect(toolMsg!.content).toContain("the answer is 42");
});

test("abort signal set before any round starts yields interrupt (no tool activity)", async () => {
  const store = new SessionStore("t7");
  const ws = mkws();
  const registry = builtinTools();
  const approvals = mkApprovals(async () => "allow");
  const provider = new ScriptedToolProvider([
    { toolCalls: [{ name: "read_file", args: { path: "x.txt" } }] },
  ]);
  const eng = new Engine({ provider, store, model: "m", tools: { registry, ws, approvals } });
  const ctl = new AbortController();
  ctl.abort();
  await drain(eng.send("go", { signal: ctl.signal }));
  const replayed = store.replay();
  expect(replayed.map((e) => e.type)).toEqual(["user_message", "turn_end"]);
  expect((replayed.at(-1) as any).stop).toBe("interrupt");
});

// --- Fix round: review findings ------------------------------------------

test("[Critical] decide() rejecting is treated as deny — ok:false tool_result 'approval error: ...', turn completes without throwing", async () => {
  const store = new SessionStore("t8");
  const ws = mkws();
  writeFileSync(join(ws.root, "x.txt"), "hi");
  const registry = builtinTools();
  const approvals = mkApprovals(async () => { throw new Error("disk full"); });
  const provider = new ScriptedToolProvider([
    { toolCalls: [{ name: "read_file", args: { path: "x.txt" } }] },
    { delta: ["ok"] },
  ]);

  const eng = new Engine({ provider, store, model: "m", tools: { registry, ws, approvals } });
  let threw = false;
  try {
    await drain(eng.send("go"));
  } catch {
    threw = true;
  }
  expect(threw).toBe(false);

  const replayed = store.replay();
  const tr = replayed.find((e) => e.type === "tool_result") as any;
  expect(tr).toBeDefined();
  expect(tr.ok).toBe(false);
  expect(tr.output).toContain("approval error");
  expect(tr.output).toContain("disk full");
  expect((replayed.at(-1) as any).type).toBe("turn_end");
});

test("[Important] abort mid-approval-wait: tool never runs even though decide() later resolves 'allow'", async () => {
  const store = new SessionStore("t9");
  const ws = mkws();
  writeFileSync(join(ws.root, "x.txt"), "hi");
  let ran = 0;
  const inner = builtinTools().get("read_file")!;
  const spyRead: BuiltinTool = {
    spec: inner.spec,
    async run(args, w) { ran++; return inner.run(args, w); },
  };
  const registry = builtinTools();
  registry.set("read_file", spyRead);

  let resolveAsk!: (v: "allow") => void;
  const askPromise = new Promise<"allow">((res) => { resolveAsk = res; });
  const approvals = mkApprovals(() => askPromise as unknown as Promise<"allow" | "deny" | "always">);

  const provider = new ScriptedToolProvider([
    { toolCalls: [{ name: "read_file", args: { path: "x.txt" } }] },
  ]);
  const eng = new Engine({ provider, store, model: "m", tools: { registry, ws, approvals } });
  const ctl = new AbortController();

  const it = eng.send("go", { signal: ctl.signal })[Symbol.asyncIterator]();
  const donePromise = (async () => {
    const out: any[] = [];
    let r = await it.next();
    while (!r.done) { out.push(r.value); r = await it.next(); }
    return out;
  })();

  // Give the engine a tick to reach the pending decide()/ask() before we abort.
  await new Promise((r) => setTimeout(r, 20));
  ctl.abort();
  resolveAsk("allow");
  await donePromise;

  expect(ran).toBe(0);
  const replayed = store.replay();
  expect(replayed.some((e) => e.type === "tool_result" && (e as any).ok === true)).toBe(false);
  expect((replayed.at(-1) as any).stop).toBe("interrupt");
});
