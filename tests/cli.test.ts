import { test, expect, beforeEach } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRepl, providerFor, createModelCommand } from "../src/cli";
import { createAsk, createApproveCommand } from "../src/commands";
import { Engine } from "../src/engine";
import { SessionStore, razielHome } from "../src/session";
import { FakeProvider } from "../src/providers/fake";
import { AnthropicProvider } from "../src/providers/anthropic";
import { OllamaProvider } from "../src/providers/ollama";
import { OpenAICompatProvider } from "../src/providers/openai_compat";
import { getProfile, type ModelProfile } from "../src/profiles";
import { Workspace } from "../src/tools/workspace";
import { builtinTools } from "../src/tools/registry";
import { Rules } from "../src/rules";
import { ApprovalManager } from "../src/approvals";
import type { ChatMessage, Provider, StreamChunk } from "../src/provider";

beforeEach(() => { process.env.RAZIEL_HOME = mkdtempSync(join(tmpdir(), "raziel-test-")); });

async function* lines(...ls: string[]) { for (const l of ls) yield l; }

/** Never resolves — used to prove the deny-default timer wins the race
 * against a stalled input source rather than hanging forever. */
async function* hang(): AsyncGenerator<string> {
  await new Promise<never>(() => {});
  yield "unreachable";
}

/** Per-round scripted provider (Task 6 pattern): round i yields that
 * round's tool calls / delta text, giving exact control over how many
 * tool_call rounds a scripted turn produces (unlike FakeProvider.scriptTool,
 * which re-advertises forever). */
class ScriptedToolProvider implements Provider {
  readonly name = "scripted";
  private i = 0;
  constructor(private rounds: { delta?: string[]; toolCalls?: { name: string; args: unknown }[] }[]) {}

  async *stream(opts: {
    model: string; system?: string; messages: ChatMessage[]; signal?: AbortSignal;
    sampling?: unknown; contextTokens?: number; tools?: unknown;
  }): AsyncIterable<StreamChunk> {
    const round = this.rounds[Math.min(this.i, this.rounds.length - 1)] ?? {};
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

function mkWorkspaceWithFile(name: string, content: string): Workspace {
  const dir = mkdtempSync(join(tmpdir(), "raziel-cli-ws-"));
  writeFileSync(join(dir, name), content);
  return new Workspace(dir);
}

// --- Task 8: approval UX wired through the real REPL loop ---------------

test("approval 'y': card shows tool + risk, tool executes, denies nothing", async () => {
  const ws = mkWorkspaceWithFile("hello.txt", "hello world");
  const registry = builtinTools();
  const rulesPath = join(razielHome(), "rules.json");
  const rules = Rules.load(rulesPath);
  const input = lines("read the file", "y", "/quit");
  let out = "";
  const write = (s: string) => { out += s; };
  const ask = createAsk({ write, readLine: async () => { const r = await input.next(); return r.done ? undefined : r.value; } });
  const approvals = new ApprovalManager(rules, { ask }, rulesPath);
  const store = new SessionStore("cli-approve-y");
  const provider = new ScriptedToolProvider([
    { toolCalls: [{ name: "read_file", args: { path: "hello.txt" } }] },
    { delta: ["done"] },
  ]);
  const engine = new Engine({ provider, store, model: "m", tools: { registry, ws, approvals } });

  await runRepl({ engine: { current: engine }, input, write });

  expect(out).toContain("tool: read_file");
  expect(out).toContain("risk: low");
  const tr = store.replay().find((e) => e.type === "tool_result") as any;
  expect(tr.ok).toBe(true);
  expect(tr.output).toContain("hello world");
});

test("approval non-'y' (e.g. 'x'): tool never runs, denied", async () => {
  const ws = mkWorkspaceWithFile("hello.txt", "hello world");
  const registry = builtinTools();
  const rulesPath = join(razielHome(), "rules.json");
  const rules = Rules.load(rulesPath);
  const input = lines("read the file", "x", "/quit");
  let out = "";
  const write = (s: string) => { out += s; };
  const ask = createAsk({ write, readLine: async () => { const r = await input.next(); return r.done ? undefined : r.value; } });
  const approvals = new ApprovalManager(rules, { ask }, rulesPath);
  const store = new SessionStore("cli-approve-deny");
  const provider = new ScriptedToolProvider([
    { toolCalls: [{ name: "read_file", args: { path: "hello.txt" } }] },
    { delta: ["done"] },
  ]);
  const engine = new Engine({ provider, store, model: "m", tools: { registry, ws, approvals } });

  await runRepl({ engine: { current: engine }, input, write });

  const tr = store.replay().find((e) => e.type === "tool_result") as any;
  expect(tr.ok).toBe(false);
  expect(tr.output).toBe("denied by user");
});

test("approval 'a': persists rules.json under RAZIEL_HOME, and an identical second call doesn't re-ask", async () => {
  const ws = mkWorkspaceWithFile("hello.txt", "hello world");
  const registry = builtinTools();
  const rulesPath = join(razielHome(), "rules.json");
  const rules = Rules.load(rulesPath);
  const input = lines("t1", "a", "t2", "/quit");
  let out = "";
  const write = (s: string) => { out += s; };
  let askCalls = 0;
  const rawAsk = createAsk({ write, readLine: async () => { const r = await input.next(); return r.done ? undefined : r.value; } });
  const ask = async (card: string, risk: any) => { askCalls++; return rawAsk(card, risk); };
  const approvals = new ApprovalManager(rules, { ask }, rulesPath);
  const store = new SessionStore("cli-approve-always");
  const provider = new ScriptedToolProvider([
    { toolCalls: [{ name: "read_file", args: { path: "hello.txt" } }] },
    { delta: ["ok1"] },
    { toolCalls: [{ name: "read_file", args: { path: "hello.txt" } }] },
    { delta: ["ok2"] },
  ]);
  const engine = new Engine({ provider, store, model: "m", tools: { registry, ws, approvals } });

  await runRepl({ engine: { current: engine }, input, write });

  expect(existsSync(rulesPath)).toBe(true);
  expect(askCalls).toBe(1);
  const results = store.replay().filter((e) => e.type === "tool_result") as any[];
  expect(results.length).toBe(2);
  expect(results.every((r) => r.ok)).toBe(true);
});

test("/approve: bare lists standing rules with a count", () => {
  const rulesPath = join(razielHome(), "rules.json");
  const rules = Rules.load(rulesPath);
  rules.add({ tool: "read_file", pattern: '*"path":"hello.txt"*' });
  rules.save(rulesPath);
  let out = "";
  const cmd = createApproveCommand({ rules, rulesPath, write: (s) => { out += s; } });

  const result = cmd("/approve");

  expect(result).toBe("handled");
  expect(out).toContain("read_file");
  expect(out).toContain("1");
});

test("/approve rm <n>: removes the rule and saves", () => {
  const rulesPath = join(razielHome(), "rules.json");
  const rules = Rules.load(rulesPath);
  rules.add({ tool: "read_file", pattern: '*"path":"hello.txt"*' });
  rules.save(rulesPath);
  let out = "";
  const cmd = createApproveCommand({ rules, rulesPath, write: (s) => { out += s; } });

  const result = cmd("/approve rm 1");

  expect(result).toBe("handled");
  expect(rules.count()).toBe(0);
  expect(Rules.load(rulesPath).count()).toBe(0);
});

test("high-risk ask with an injected short timer and no input denies by default (R14)", async () => {
  const ws = mkWorkspaceWithFile("dummy.txt", "x");
  const registry = builtinTools();
  const rulesPath = join(razielHome(), "rules.json");
  const rules = Rules.load(rulesPath);
  let out = "";
  const write = (s: string) => { out += s; };
  const stalledInput = hang();
  const ask = createAsk({
    write,
    readLine: async () => { const r = await stalledInput.next(); return r.done ? undefined : r.value; },
    timeoutMs: 10,
  });
  const approvals = new ApprovalManager(rules, { ask }, rulesPath);
  const store = new SessionStore("cli-approve-timeout");
  const provider = new ScriptedToolProvider([
    { toolCalls: [{ name: "run_command", args: { argv: ["echo", "hi"] } }] },
    { delta: ["done"] },
  ]);
  const engine = new Engine({ provider, store, model: "m", tools: { registry, ws, approvals } });

  for await (const _e of engine.send("run something")) { /* drain */ }

  const tr = store.replay().find((e) => e.type === "tool_result") as any;
  expect(tr.ok).toBe(false);
  expect(tr.output).toBe("denied by user");
});

test("/model swap keeps tools working: swap then script another tool_call, still approvable/executable", async () => {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  try {
    const ws = mkWorkspaceWithFile("hello.txt", "hello world");
    const registry = builtinTools();
    const rulesPath = join(razielHome(), "rules.json");
    const rules = Rules.load(rulesPath);
    const input = lines("t1", "y", "/model qwen", "t2", "y", "/quit");
    let out = "";
    const write = (s: string) => { out += s; };
    const ask = createAsk({ write, readLine: async () => { const r = await input.next(); return r.done ? undefined : r.value; } });
    const approvals = new ApprovalManager(rules, { ask }, rulesPath);
    const store = new SessionStore("cli-model-swap-tools");
    const tools = { registry, ws, approvals };
    const providerA = new ScriptedToolProvider([
      { toolCalls: [{ name: "read_file", args: { path: "hello.txt" } }] },
      { delta: ["ok1"] },
    ]);
    const engineA = new Engine({ provider: providerA, store, model: "m-a", tools });
    const engineBox = { current: engineA };

    const providerForFn: typeof providerFor = () => new ScriptedToolProvider([
      { toolCalls: [{ name: "read_file", args: { path: "hello.txt" } }] },
      { delta: ["ok2"] },
    ]);

    const modelCmd = createModelCommand({
      engineBox, store, initialProfile: getProfile("sonnet")!, write, providerForFn, tools,
    });

    await runRepl({ engine: engineBox, input, write, onCommand: modelCmd });

    const results = store.replay().filter((e) => e.type === "tool_result") as any[];
    expect(results.length).toBe(2);
    expect(results.every((r) => r.ok)).toBe(true);
  } finally {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
  }
});

test("repl streams reply text and stops at /quit", async () => {
  const store = new SessionStore("r1");
  const engine = new Engine({ provider: new FakeProvider([["he", "y"]]), store, model: "m" });
  let out = "";
  await runRepl({ engine: { current: engine }, input: lines("hi", "/quit"), write: (s) => { out += s; } });
  expect(out).toContain("hey");
  expect(store.replay().some((e) => e.type === "assistant_message")).toBe(true);
});

test("hostile ANSI/OSC bytes in an assistant delta are sanitized before hitting write()", async () => {
  const store = new SessionStore("r-hostile");
  const hostileDelta = "\x1b]0;PWNED\x07visible\x1b[2Jtext";
  const engine = new Engine({ provider: new FakeProvider([[hostileDelta]]), store, model: "m" });
  let out = "";
  await runRepl({ engine: { current: engine }, input: lines("hi", "/quit"), write: (s) => { out += s; } });
  expect(out).not.toContain("\x1b");
  expect(out).toContain("visibletext");
});

test("hostile bytes in an error message are sanitized before hitting write()", async () => {
  const store = new SessionStore("r-hostile-err");
  const bad = {
    name: "bad",
    async *stream(): AsyncIterable<never> { throw new Error("boom\x1b]52;c;evil\x07tail"); },
  };
  const engine = new Engine({ provider: bad as any, store, model: "m" });
  let out = "";
  await runRepl({ engine: { current: engine }, input: lines("hi", "/quit"), write: (s) => { out += s; } });
  expect(out).not.toContain("\x1b");
  expect(out).toContain("boomtail");
});

// --- Task 5: providerFor -----------------------------------------------

test("providerFor returns AnthropicProvider for the sonnet profile", () => {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  try {
    const p = providerFor(getProfile("sonnet")!);
    expect(p).toBeInstanceOf(AnthropicProvider);
  } finally {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
  }
});

test("providerFor returns OllamaProvider for the qwen profile, with injected fetch", () => {
  const fetchImpl = (async () => new Response("{}")) as unknown as typeof fetch;
  const p = providerFor(getProfile("qwen")!, fetchImpl);
  expect(p).toBeInstanceOf(OllamaProvider);
});

test("providerFor returns OpenAICompatProvider for an openai-compat profile", () => {
  const profile: ModelProfile = {
    id: "compat-test", provider: "openai-compat", model: "m",
    baseUrl: "http://localhost:9999", contextTokens: 8192, maxToolSurface: 10,
    parser: "native", streamingTools: false,
  };
  const p = providerFor(profile);
  expect(p).toBeInstanceOf(OpenAICompatProvider);
});

// --- Task 5: onCommand routing + hot-swap mechanics --------------------

test("runRepl consults onCommand before treating a line as a prompt, and skips engine.send when handled", async () => {
  let sendCalls = 0;
  const fakeEngine = { send: async function* () { sendCalls++; } } as unknown as Engine;
  const onCommand = (line: string): "handled" | "not-command" =>
    line.startsWith("/model") ? "handled" : "not-command";
  let out = "";
  await runRepl({
    engine: { current: fakeEngine },
    input: lines("/model qwen", "/quit"),
    write: (s) => { out += s; },
    onCommand,
  });
  expect(sendCalls).toBe(0);
});

test("runRepl falls through to engine.send when onCommand declines the line", async () => {
  const store = new SessionStore("r-fallthrough");
  const engine = new Engine({ provider: new FakeProvider([["ok"]]), store, model: "m" });
  const onCommand = (line: string): "handled" | "not-command" =>
    line.startsWith("/model") ? "handled" : "not-command";
  let out = "";
  await runRepl({ engine: { current: engine }, input: lines("hi", "/quit"), write: (s) => { out += s; }, onCommand });
  expect(out).toContain("ok");
});

test("swap integration: a mid-session engine swap via onCommand logs both turns into one session file", async () => {
  const store = new SessionStore("swap-1");
  const engineA = new Engine({ provider: new FakeProvider([["alpha"]]), store, model: "m-a" });
  const engineBox: { current: Engine } = { current: engineA };
  const onCommand = (line: string): "handled" | "not-command" => {
    if (line !== "/model second") return "not-command";
    engineBox.current = new Engine({ provider: new FakeProvider([["beta"]]), store, model: "m-b" });
    return "handled";
  };
  let out = "";
  await runRepl({
    engine: engineBox,
    input: lines("hi", "/model second", "yo", "/quit"),
    write: (s) => { out += s; },
    onCommand,
  });
  expect(out).toContain("alpha");
  expect(out).toContain("beta");
  const texts = store.replay().filter((e) => e.type === "assistant_message").map((e) => (e as any).text);
  expect(texts).toEqual(["alpha", "beta"]);
});

// --- Task 5: createModelCommand (the real /model handler main() wires up) --

test("createModelCommand: bare /model lists profiles and marks the current one", () => {
  const store = new SessionStore("model-list");
  const engineBox = { current: new Engine({ provider: new FakeProvider([[]]), store, model: "m" }) };
  let out = "";
  const cmd = createModelCommand({
    engineBox, store, initialProfile: getProfile("sonnet")!, write: (s) => { out += s; },
  });
  const result = cmd("/model");
  expect(result).toBe("handled");
  expect(out).toContain("sonnet");
  expect(out).toContain("qwen");
});

test("createModelCommand: /model <id> swaps the engine and reprints the status line", () => {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  try {
    const store = new SessionStore("model-swap");
    const original = new Engine({ provider: new FakeProvider([[]]), store, model: "m" });
    const engineBox = { current: original };
    let out = "";
    const cmd = createModelCommand({
      engineBox, store, initialProfile: getProfile("qwen")!, write: (s) => { out += s; },
    });
    const result = cmd("/model sonnet");
    expect(result).toBe("handled");
    expect(engineBox.current).not.toBe(original);
    expect(out).toContain("claude-sonnet-5");
  } finally {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
  }
});

test("createModelCommand: /model <id> swap to an anthropic profile with no API key reports an error, does not swap, and does not kill the process", () => {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const store = new SessionStore("model-swap-no-key");
    const original = new Engine({ provider: new FakeProvider([[]]), store, model: "m" });
    const engineBox = { current: original };
    let out = "";
    // Mirrors the qwen escalateTo:"sonnet" scenario: started on a keyless
    // local profile, later tries to escalate to anthropic with no key set.
    const cmd = createModelCommand({
      engineBox, store, initialProfile: getProfile("qwen")!, write: (s) => { out += s; },
    });
    const result = cmd("/model sonnet");
    expect(result).toBe("handled");
    expect(engineBox.current).toBe(original); // no swap — qwen engine keeps working
    expect(out).toContain("ANTHROPIC_API_KEY");
    expect(out.split("\n").filter((l) => l.length > 0).length).toBe(1); // one-line error
  } finally {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
  }
});

test("createModelCommand: unknown profile id prints a one-line error and does not swap", () => {
  const store = new SessionStore("model-unknown");
  const original = new Engine({ provider: new FakeProvider([[]]), store, model: "m" });
  const engineBox = { current: original };
  let out = "";
  const cmd = createModelCommand({
    engineBox, store, initialProfile: getProfile("sonnet")!, write: (s) => { out += s; },
  });
  const result = cmd("/model does-not-exist");
  expect(result).toBe("handled");
  expect(engineBox.current).toBe(original);
  expect(out).toContain("does-not-exist");
  expect(out.split("\n").filter((l) => l.length > 0).length).toBe(1);
});

test("createModelCommand: a non-/model line is not-command", () => {
  const store = new SessionStore("model-passthrough");
  const engineBox = { current: new Engine({ provider: new FakeProvider([[]]), store, model: "m" }) };
  const cmd = createModelCommand({ engineBox, store, initialProfile: getProfile("sonnet")!, write: () => {} });
  expect(cmd("hello there")).toBe("not-command");
});
