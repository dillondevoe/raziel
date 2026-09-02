import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine";
import { SessionStore } from "../src/session";
import { FakeProvider } from "../src/providers/fake";
import { getProfile } from "../src/profiles";
import { createModelCommand, type providerFor } from "../src/commands";
import { createSessionCommand, createEscalateCommand, type ProfileBox } from "../src/tui/session_cmd";

type ProviderForFn = typeof providerFor;

beforeEach(() => {
  process.env.RAZIEL_HOME = mkdtempSync(join(tmpdir(), "raziel-session-cmd-"));
});

// --- /session -------------------------------------------------------------

test("/session bare lists sessions (delegates to listSessions)", () => {
  new SessionStore("s-one").append({ id: "e1", ts: new Date().toISOString(), type: "user_message", text: "hi one" } as any);
  new SessionStore("s-two").append({ id: "e2", ts: new Date().toISOString(), type: "user_message", text: "hi two" } as any);

  const store = new SessionStore("s-one");
  const engineBox = { current: new Engine({ provider: new FakeProvider([[]]), store, model: "m" }) };
  const profileBox: ProfileBox = { current: getProfile("sonnet")! };
  let out = "";
  const storeBox = { current: store };
  const cmd = createSessionCommand({ engineBox, profileBox, storeBox, write: (s) => { out += s; } });

  const result = cmd("/session");

  expect(result).toBe("handled");
  expect(out).toContain("s-one");
  expect(out).toContain("s-two");
});

test("/session <id>: rebuilds the engine over that session's store, writes a resumed <id8> line", () => {
  // SessionStore's constructor alone doesn't create a file on disk — only an
  // append() does (mirrors --session's own "resume an existing session"
  // semantics at startup) — so a resumable fixture needs a real event.
  new SessionStore("target-session").append({ id: "e0", ts: new Date().toISOString(), type: "user_message", text: "prior" } as any);
  const store = new SessionStore("origin-session");
  const originEngine = new Engine({ provider: new FakeProvider([[]]), store, model: "m" });
  const engineBox = { current: originEngine };
  const profileBox: ProfileBox = { current: getProfile("sonnet")! };
  let out = "";
  const providerForFn = (() => new FakeProvider([["ok"]])) as unknown as ProviderForFn;
  const storeBox = { current: store };
  const cmd = createSessionCommand({ engineBox, profileBox, storeBox, write: (s) => { out += s; }, providerForFn });

  const result = cmd("/session target-session");

  expect(result).toBe("handled");
  expect(engineBox.current).not.toBe(originEngine);
  expect(out).toContain("resumed target-s"); // id8 of "target-session"
});

test("/session <id>: a subsequent turn appends to the OTHER session's file, not the original", async () => {
  new SessionStore("other-session").append({ id: "e0", ts: new Date().toISOString(), type: "user_message", text: "prior" } as any);
  const store = new SessionStore("origin-session-2");
  const originEngine = new Engine({ provider: new FakeProvider([["orig"]]), store, model: "m" });
  const engineBox = { current: originEngine };
  const profileBox: ProfileBox = { current: getProfile("sonnet")! };
  const providerForFn = (() => new FakeProvider([["from other"]])) as unknown as ProviderForFn;
  const storeBox = { current: store };
  const cmd = createSessionCommand({ engineBox, profileBox, storeBox, write: () => {}, providerForFn });

  cmd("/session other-session");
  for await (const _e of engineBox.current.send("hello")) { /* drain */ }

  const otherEvents = new SessionStore("other-session").replay();
  expect(otherEvents.some((e) => e.type === "assistant_message" && (e as any).text === "from other")).toBe(true);

  const origEvents = new SessionStore("origin-session-2").replay();
  expect(origEvents.length).toBe(0); // nothing landed in the session /session left behind
});

test("/session <invalid-id>: one error line, no crash, engineBox untouched", () => {
  const store = new SessionStore("origin-session-3");
  const originEngine = new Engine({ provider: new FakeProvider([[]]), store, model: "m" });
  const engineBox = { current: originEngine };
  const profileBox: ProfileBox = { current: getProfile("sonnet")! };
  let out = "";
  const storeBox = { current: store };
  const cmd = createSessionCommand({ engineBox, profileBox, storeBox, write: (s) => { out += s; } });

  const result = cmd("/session ../escape");

  expect(result).toBe("handled");
  expect(engineBox.current).toBe(originEngine);
  expect(out.split("\n").filter((l) => l.length > 0).length).toBe(1);
});

test("/session <unknown-but-valid-id>: one error line, no crash, engineBox untouched", () => {
  const store = new SessionStore("origin-session-4");
  const originEngine = new Engine({ provider: new FakeProvider([[]]), store, model: "m" });
  const engineBox = { current: originEngine };
  const profileBox: ProfileBox = { current: getProfile("sonnet")! };
  let out = "";
  const storeBox = { current: store };
  const cmd = createSessionCommand({ engineBox, profileBox, storeBox, write: (s) => { out += s; } });

  const result = cmd("/session never-created-this-one");

  expect(result).toBe("handled");
  expect(engineBox.current).toBe(originEngine);
  expect(out).toContain("unknown session");
});

test("/session: a non-/session line is not-command", () => {
  const store = new SessionStore("passthrough");
  const engineBox = { current: new Engine({ provider: new FakeProvider([[]]), store, model: "m" }) };
  const profileBox: ProfileBox = { current: getProfile("sonnet")! };
  const storeBox = { current: store };
  const cmd = createSessionCommand({ engineBox, profileBox, storeBox, write: () => {} });
  expect(cmd("hello there")).toBe("not-command");
});

// --- /escalate --------------------------------------------------------

test("/escalate on a profile with escalateTo swaps the engine (qwen -> sonnet) and writes a confirmation", () => {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  try {
    const store = new SessionStore("escalate-1");
    const originEngine = new Engine({ provider: new FakeProvider([[]]), store, model: "m" });
    const engineBox = { current: originEngine };
    const profileBox: ProfileBox = { current: getProfile("qwen")! }; // qwen.escalateTo === "sonnet"
    let out = "";
    const modelCmd = createModelCommand({
      engineBox, store, initialProfile: getProfile("qwen")!, write: (s) => { out += s; },
      onSwap: (info) => { profileBox.current = info.profile; },
    });
    const escalateCmd = createEscalateCommand({ engineBox, profileBox, modelCmd, write: (s) => { out += s; } });

    const result = escalateCmd("/escalate");

    expect(result).toBe("handled");
    expect(engineBox.current).not.toBe(originEngine);
    expect(profileBox.current.id).toBe("sonnet");
    expect(out).toContain("escalated to sonnet");
  } finally {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
  }
});

test("/escalate without an escalateTo target reports it and does not touch engineBox", () => {
  const store = new SessionStore("escalate-2");
  const originEngine = new Engine({ provider: new FakeProvider([[]]), store, model: "m" });
  const engineBox = { current: originEngine };
  const profileBox: ProfileBox = { current: getProfile("sonnet")! }; // sonnet has no escalateTo
  let out = "";
  const modelCmd = createModelCommand({ engineBox, store, initialProfile: getProfile("sonnet")!, write: () => {} });
  const escalateCmd = createEscalateCommand({ engineBox, profileBox, modelCmd, write: (s) => { out += s; } });

  const result = escalateCmd("/escalate");

  expect(result).toBe("handled");
  expect(engineBox.current).toBe(originEngine);
  expect(out).toContain("no escalation target for sonnet");
});

test("/escalate: a failed underlying /model swap (no API key) writes no \"escalated to\" line", () => {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const store = new SessionStore("escalate-3");
    const originEngine = new Engine({ provider: new FakeProvider([[]]), store, model: "m" });
    const engineBox = { current: originEngine };
    const profileBox: ProfileBox = { current: getProfile("qwen")! };
    let out = "";
    const modelCmd = createModelCommand({ engineBox, store, initialProfile: getProfile("qwen")!, write: (s) => { out += s; } });
    const escalateCmd = createEscalateCommand({ engineBox, profileBox, modelCmd, write: (s) => { out += s; } });

    const result = escalateCmd("/escalate");

    expect(result).toBe("handled");
    expect(engineBox.current).toBe(originEngine); // no swap happened
    expect(out).not.toContain("escalated to");
    expect(out).toContain("ANTHROPIC_API_KEY");
  } finally {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
  }
});

test("/escalate: a non-/escalate line is not-command", () => {
  const store = new SessionStore("passthrough-2");
  const engineBox = { current: new Engine({ provider: new FakeProvider([[]]), store, model: "m" }) };
  const profileBox: ProfileBox = { current: getProfile("sonnet")! };
  const modelCmd = createModelCommand({ engineBox, store, initialProfile: getProfile("sonnet")!, write: () => {} });
  const escalateCmd = createEscalateCommand({ engineBox, profileBox, modelCmd, write: () => {} });
  expect(escalateCmd("hello there")).toBe("not-command");
});

// --- Final-fix-round I1: /session resume must survive a later /model swap ---

test("(I1) resume session-b, then /model swap: turn lands in session-b's file, original untouched, statusline still shows b", async () => {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  try {
    new SessionStore("session-b").append({ id: "e0", ts: new Date().toISOString(), type: "user_message", text: "prior" } as any);
    const originStore = new SessionStore("session-origin");
    const originEngine = new Engine({ provider: new FakeProvider([[]]), store: originStore, model: "m" });
    const engineBox = { current: originEngine };
    const profileBox: ProfileBox = { current: getProfile("qwen")! };
    const storeBox = { current: originStore }; // SHARED between session_cmd and model_cmd
    let out = "";
    const write = (s: string) => { out += s; };

    const providerForFn = (() => new FakeProvider([["after swap"]])) as unknown as ProviderForFn;
    const sessionCmd = createSessionCommand({ engineBox, profileBox, storeBox, write, providerForFn });
    const modelCmd = createModelCommand({
      engineBox, store: originStore, storeBox, initialProfile: getProfile("qwen")!, write, providerForFn,
      onSwap: (info) => { profileBox.current = info.profile; },
    });

    sessionCmd("/session session-b");
    expect(storeBox.current.id).toBe("session-b");

    out = "";
    modelCmd("/model sonnet");
    expect(storeBox.current.id).toBe("session-b"); // untouched by the /model swap
    expect(out).toContain("session session-b"); // statusLine() used the resumed store, not the original

    for await (const _e of engineBox.current.send("hello")) { /* drain */ }

    const sessionBEvents = new SessionStore("session-b").replay();
    expect(sessionBEvents.some((e) => e.type === "assistant_message" && (e as any).text === "after swap")).toBe(true);

    const originEvents = new SessionStore("session-origin").replay();
    expect(originEvents.length).toBe(0); // nothing ever landed in the session /session left behind
  } finally {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
  }
});
