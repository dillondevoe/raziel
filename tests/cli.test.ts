import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRepl, providerFor, createModelCommand } from "../src/cli";
import { Engine } from "../src/engine";
import { SessionStore } from "../src/session";
import { FakeProvider } from "../src/providers/fake";
import { AnthropicProvider } from "../src/providers/anthropic";
import { OllamaProvider } from "../src/providers/ollama";
import { OpenAICompatProvider } from "../src/providers/openai_compat";
import { getProfile, type ModelProfile } from "../src/profiles";

beforeEach(() => { process.env.RAZIEL_HOME = mkdtempSync(join(tmpdir(), "raziel-test-")); });

async function* lines(...ls: string[]) { for (const l of ls) yield l; }

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
