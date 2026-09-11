import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyBudget } from "../src/context_budget";
import { Engine } from "../src/engine";
import { SessionStore } from "../src/session";
import { Workspace } from "../src/tools/workspace";
import { Rules } from "../src/rules";
import { ApprovalManager } from "../src/approvals";
import { builtinTools } from "../src/tools/registry";
import { toOllamaMessages } from "../src/providers/ollama";
import type { ChatMessage, Provider, StreamChunk, ToolResult } from "../src/provider";
import type { ModelProfile } from "../src/profiles";

function round(outputs: string[], args: unknown = { path: "src/engine.ts" }): ChatMessage[] {
  return [
    { role: "assistant", content: "assistant evidence", toolCalls: outputs.map((_, i) => ({ id: `c${i}`, name: "read_file", args })) },
    { role: "tool", results: outputs.map((output, i) => ({ id: `c${i}`, name: "read_file", ok: true, output })) },
  ];
}
function results(msgs: ChatMessage[]): ToolResult[] {
  return msgs.flatMap(m => m.role === "tool" ? m.results : []);
}
function freeze(v: any): void {
  if (v && typeof v === "object") { Object.values(v).forEach(freeze); Object.freeze(v); }
}

test("below and exactly at the trigger are deep-equal passthrough, including large outputs", () => {
  const msgs = [{ role: "user" as const, content: "question" }, ...round(["x".repeat(12404)])];
  const initial = structuredClone(msgs);
  const estimated = Math.ceil(JSON.stringify(msgs).length / 4);
  for (const contextTokens of [100000, estimated / 0.6]) {
    const view = applyBudget(msgs, { contextTokens, keepRecentRounds: 0 });
    expect(view.msgs).toEqual(initial);
    expect(view.msgs).toBe(msgs);
    expect(view.evicted).toBe(0);
    expect(view.estimatedTokens).toBe(estimated);
  }
});

test("over trigger evicts oldest first; preserves recent rounds, failures, small slots, text and input", () => {
  const old = round(["a".repeat(12404), "denial".repeat(400), "small"]);
  results(old)[1]!.ok = false;
  const msgs: ChatMessage[] = [{ role: "user", content: "user evidence" }, ...old,
    ...round(["b".repeat(7000)]), ...round(["c".repeat(2200)]), ...round(["d".repeat(2200)])];
  const before = structuredClone(msgs);
  freeze(msgs);
  const view = applyBudget(msgs, { contextTokens: 8000 });
  expect(view.evicted).toBe(1);
  expect(view.estimatedTokens).toBeLessThanOrEqual(4000);
  expect(view.msgs).toHaveLength(msgs.length);
  expect(results(view.msgs).map(({ output, ...slot }) => slot)).toEqual(results(msgs).map(({ output, ...slot }) => slot));
  expect(results(view.msgs)[0]!.output).toBe('[evicted from context: read_file {"path":"src/engine.ts"} → 12,404 chars; call the tool again if you need it]');
  expect(results(view.msgs).slice(1)).toEqual(results(msgs).slice(1));
  expect(view.msgs.filter(m => m.role !== "tool")).toEqual(msgs.filter(m => m.role !== "tool"));
  expect(msgs).toEqual(before);
  expect(applyBudget(msgs, { contextTokens: 8000 })).toEqual(view);
  expect(view.estimatedTokens).toBe(Math.ceil(JSON.stringify(view.msgs).length / 4));
});

test("evicts multiple eligible outputs to target and returns cleanly when protected context cannot fit", () => {
  const msgs = [...round(["a".repeat(10000)]), ...round(["b".repeat(10000)]), ...round(["recent"]), ...round(["recent"])];
  const view = applyBudget(msgs, { contextTokens: 2000 });
  expect(view.evicted).toBe(2);
  expect(view.estimatedTokens).toBeLessThanOrEqual(1000);
  const protectedMsgs: ChatMessage[] = [{ role: "user", content: "u".repeat(10000) }, ...round(["x".repeat(10000)])];
  const exhausted = applyBudget(protectedMsgs, { contextTokens: 100 });
  expect(exhausted.evicted).toBe(0);
  expect(exhausted.msgs).toEqual(protectedMsgs);
  expect(exhausted.estimatedTokens).toBeGreaterThan(50);
});

test("args are canonical, one-line and truncated to 200 characters", () => {
  const args = { z: "line\nbreak" + "x".repeat(300), a: { z: 1, a: 2 } };
  const view = applyBudget(round(["x".repeat(3000)], args), { contextTokens: 100, keepRecentRounds: 0 });
  const canonical = JSON.stringify({ a: { a: 2, z: 1 }, z: args.z });
  expect(results(view.msgs)[0]!.output).toBe(`[evicted from context: read_file ${canonical.slice(0, 200)} → 3,000 chars; call the tool again if you need it]`);
  expect(results(view.msgs)[0]!.output.split("\n")).toHaveLength(1);
});

test("args join uses local id before position, falls back to position, and never invents an orphan call", () => {
  const msgs = round(["x".repeat(3000), "y".repeat(3000)]);
  const assistant = msgs[0] as Extract<ChatMessage, { role: "assistant" }>;
  assistant.toolCalls![0]!.args = { path: "first" };
  assistant.toolCalls![1]!.args = { path: "second" };
  results(msgs)[0]!.id = "c1";
  results(msgs)[1]!.id = "unknown";
  const view = applyBudget(msgs, { contextTokens: 10, keepRecentRounds: 0 });
  expect(results(view.msgs).every(r => r.output.includes('{"path":"second"}'))).toBe(true);
  const orphan: ChatMessage[] = [{ role: "tool", results: [{ id: "c1", name: "read_file", ok: true, output: "z".repeat(3000) }] }];
  expect(applyBudget(orphan, { contextTokens: 10, keepRecentRounds: 0 }).msgs).toEqual(orphan);
});

test("minEvictChars boundary and pointless stubs are respected", () => {
  const view = applyBudget(round(["x".repeat(1999), "y".repeat(2000)]), { contextTokens: 1, keepRecentRounds: 0 });
  expect(view.evicted).toBe(1);
  expect(results(view.msgs)[0]!.output).toHaveLength(1999);
  expect(applyBudget(round(["tiny"]), { contextTokens: 1, keepRecentRounds: 0, minEvictChars: 0 }).evicted).toBe(0);
});

test("ollama maps the evicted view to one tool slot per call in original array order", () => {
  const msgs = round(["x".repeat(3000), "denied", "small"]);
  results(msgs)[1]!.ok = false;
  const view = applyBudget(msgs, { contextTokens: 100, keepRecentRounds: 0 });
  const wire = toOllamaMessages(view.msgs);
  expect(wire[0]!.tool_calls).toHaveLength(3);
  expect(wire.slice(1).map(m => m.role)).toEqual(["tool", "tool", "tool"]);
  expect(wire.slice(1).map(m => m.content)).toEqual(results(view.msgs).map(r => r.output));
  expect(wire[1]!.content).toContain("[evicted from context:");
  expect(wire.slice(2).map(m => m.content)).toEqual(["denied", "small"]);
});

async function drain(it: AsyncIterable<{ type: string }>) {
  const out: any[] = []; for await (const e of it) out.push(e); return out;
}
function mkApprovals(): ApprovalManager {
  const path = join(mkdtempSync(join(tmpdir(), "raziel-budget-rules-")), "rules.json");
  return new ApprovalManager(Rules.load(path), { ask: async () => "allow" }, path);
}
class ScriptedToolProvider implements Provider {
  readonly name = "scripted";
  calls: ChatMessage[][] = [];
  constructor(private paths: string[] = []) {}
  async *stream(opts: { messages: ChatMessage[] }): AsyncIterable<StreamChunk> {
    const path = this.paths[this.calls.length];
    this.calls.push(opts.messages);
    if (path) yield { type: "tool_call", id: "call_0", name: "read_file", args: { path } };
    else yield { type: "delta", text: "done" };
    yield { type: "done", stopReason: "end" };
  }
}
const profile: ModelProfile = { id: "tiny", provider: "ollama", model: "fake", contextTokens: 1000,
  maxToolSurface: 7, parser: "native", streamingTools: true };

beforeEach(() => { process.env.RAZIEL_HOME = mkdtempSync(join(tmpdir(), "raziel-budget-home-")); });

test("Engine round 4 sees a stub, while persisted output and earlier provider views retain all bytes", async () => {
  const store = new SessionStore("budget");
  const ws = new Workspace(mkdtempSync(join(tmpdir(), "raziel-budget-ws-")));
  const big = "B".repeat(12404);
  writeFileSync(join(ws.root, "big.txt"), big);
  writeFileSync(join(ws.root, "small.txt"), "small");
  const provider = new ScriptedToolProvider(["big.txt", "small.txt", "small.txt"]);
  const tools = { registry: builtinTools(), ws, approvals: mkApprovals() };
  const events = await drain(new Engine({ provider, store, profile, tools }).send("read"));
  expect(events.some(e => e.type === "error")).toBe(false);
  expect(provider.calls).toHaveLength(4);
  expect(results(provider.calls[1]!)[0]!.output).toBe(big);
  expect(results(provider.calls[2]!)[0]!.output).toBe(big);
  expect(results(provider.calls[3]!)[0]!.output).toContain('[evicted from context: read_file {"path":"big.txt"}');
  expect(store.replay().find(e => e.type === "tool_result")?.output).toBe(big);

  // No-tools sends must budget replay too; raw-model sends deliberately do not.
  const noTools = new ScriptedToolProvider();
  await drain(new Engine({ provider: noTools, store, profile }).send("again"));
  expect(results(noTools.calls[0]!)[0]!.output).toContain("[evicted from context:");
  const raw = new ScriptedToolProvider();
  await drain(new Engine({ provider: raw, store, model: "fake" }).send("raw"));
  expect(results(raw.calls[0]!)[0]!.output).toBe(big);
  expect(store.replay().find(e => e.type === "tool_result")?.output).toBe(big);
});

// Geist, after the live arm 2026-09-11: six big reads in ONE round of turn 1,
// then a new user turn -- nothing evicted, because "the last two rounds" was
// counted across the whole session and that single round was the newest.
// Recency protects the CURRENT turn only: rounds after the newest user
// message. Everything before it is history and eligible, oldest first.
test("a previous turn's single big round is eligible once a new user turn begins; the current turn's last rounds stay protected", () => {
  // exactly the live shape: one round in turn 1, a new user turn with NO rounds yet
  const prev: ChatMessage[] = [{ role: "user", content: "read them" }, ...round(["p".repeat(20000)]), { role: "assistant", content: "6" }];
  const noRounds = applyBudget([...prev, { role: "user", content: "next question" }], { contextTokens: 6000 });
  expect(noRounds.evicted).toBe(1);
  expect(results(noRounds.msgs)[0]!.output).toContain("[evicted from context: read_file");
  // and with rounds in the new turn, only the new turn's last rounds are protected
  const cur: ChatMessage[] = [{ role: "user", content: "next question" }, ...round(["q".repeat(6000)]), ...round(["r".repeat(6000)])];
  const view = applyBudget([...prev, ...cur], { contextTokens: 12000 });
  expect(results(view.msgs)[0]!.output).toContain("[evicted from context: read_file");
  expect(results(view.msgs)[1]!.output).toBe("q".repeat(6000));
  expect(results(view.msgs)[2]!.output).toBe("r".repeat(6000));
});

test("within a single turn the last two rounds are protected even when older rounds do not reach the target", () => {
  const msgs: ChatMessage[] = [{ role: "user", content: "go" }, ...round(["a".repeat(9000)]), ...round(["b".repeat(9000)]), ...round(["c".repeat(9000)])];
  const view = applyBudget(msgs, { contextTokens: 6000 });
  expect(results(view.msgs)[0]!.output).toContain("[evicted");
  expect(results(view.msgs)[1]!.output).toBe("b".repeat(9000));
  expect(results(view.msgs)[2]!.output).toBe("c".repeat(9000));
});
