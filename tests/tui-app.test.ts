import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Terminal } from "@earendil-works/pi-tui";
import { SessionStore } from "../src/session";
import { getProfile } from "../src/profiles";
import { Workspace } from "../src/tools/workspace";
import { builtinTools } from "../src/tools/registry";
import { Rules } from "../src/rules";
import { createTuiApp, type TuiAppDeps } from "../src/tui/app";
import type { ChatMessage, Provider, StreamChunk } from "../src/provider";

// M1c Task 5 — headless end-to-end: a real running TuiAltScreen (against a
// stub Terminal — reference §8's headless pattern, same as every other TUI
// test in this repo) driven through createTuiApp, proving the FULL wiring:
// engine.send() -> Transcript/Status, a real tool_call -> the real
// ApprovalManager -> a real mounted approval card -> a REAL raw keypress
// through the stub terminal's input-listener pipeline -> execution -> the
// result card, and requirement A's ctrl-c-during-approval force-deny path.

const CTRL_C = "\x03";

function makeStubTerminal(): Terminal & { writes: string[]; onInput?: (data: string) => void } {
  const writes: string[] = [];
  const stub: Terminal & { writes: string[]; onInput?: (data: string) => void } = {
    writes,
    onInput: undefined,
    start(onInput: (data: string) => void, _onResize: () => void) {
      stub.onInput = onInput;
    },
    stop() {},
    async drainInput() {},
    write(data: string) { writes.push(data); },
    get columns() { return 80; },
    get rows() { return 24; },
    get kittyProtocolActive() { return false; },
    moveBy(_lines: number) {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    setTitle(_title: string) {},
    setProgress(_active: boolean) {},
  };
  return stub;
}

/** Per-round scripted provider (same shape cli.test.ts / tui-loop.test.ts
 * use) — exact control over which round produces which tool calls/deltas. */
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

async function waitFor(check: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 2));
  }
}

function mkWorkspaceWithFile(name: string, content: string): Workspace {
  const dir = mkdtempSync(join(tmpdir(), "raziel-tui-app-ws-"));
  writeFileSync(join(dir, name), content);
  return new Workspace(dir);
}

function baseDeps(provider: Provider): TuiAppDeps {
  return {
    terminal: makeStubTerminal(),
    provider,
    store: new SessionStore(`tui-app-${crypto.randomUUID()}`),
    profile: getProfile("sonnet")!,
    registryFull: builtinTools(),
    ws: mkWorkspaceWithFile("hello.txt", "hello world"),
    rules: Rules.load(join(mkdtempSync(join(tmpdir(), "raziel-tui-app-rules-")), "rules.json")),
    rulesPath: join(mkdtempSync(join(tmpdir(), "raziel-tui-app-rules2-")), "rules.json"),
  };
}

beforeEach(() => { process.env.RAZIEL_HOME = mkdtempSync(join(tmpdir(), "raziel-tui-app-")); });

test("scripted turn streams into the transcript via the real running TUI", async () => {
  const provider = new ScriptedToolProvider([{ delta: ["hello ", "world"] }]);
  const deps = baseDeps(provider);
  const { surface, ready } = createTuiApp(deps);
  surface.start();
  try {
    const handles = await ready;
    handles.editor.onSubmit?.("say hi");
    await waitFor(() => handles.tui.render(80).join("\n").includes("hello world"));

    const frame = handles.tui.render(80).join("\n");
    expect(frame).toContain("say hi");
    expect(frame).toContain("hello world");
  } finally {
    surface.stop();
  }
});

test("scripted tool_call flow: card -> real 'y' keypress through the terminal -> executed -> result card", async () => {
  const terminal = makeStubTerminal();
  const provider = new ScriptedToolProvider([
    { toolCalls: [{ name: "read_file", args: { path: "hello.txt" } }] },
    { delta: ["read it"] },
  ]);
  const deps = { ...baseDeps(provider), terminal };
  const { surface, ready } = createTuiApp(deps);
  surface.start();
  try {
    const handles = await ready;
    handles.editor.onSubmit?.("read the file");

    await waitFor(() => handles.tui.render(80).join("\n").includes("read_file"));
    let frame = handles.tui.render(80).join("\n");
    expect(frame).toContain("risk: low");
    expect(frame).toContain("y=allow");

    terminal.onInput?.("y"); // real raw byte through the stub terminal's input pipeline

    await waitFor(() => handles.tui.render(80).join("\n").includes("read it"));
    frame = handles.tui.render(80).join("\n");
    expect(frame).not.toContain("y=allow"); // card hidden
    expect(frame).toContain("✓"); // result card ok mark
    expect(frame).toContain("hello world"); // tool_result output preview

    const events = deps.store.replay();
    const tr = events.find((e) => e.type === "tool_result") as any;
    expect(tr.ok).toBe(true);
  } finally {
    surface.stop();
  }
});

test("(A) ctrl+c while an approval card is open force-denies the ask, hides the card, and ends the turn as interrupted", async () => {
  const terminal = makeStubTerminal();
  const provider = new ScriptedToolProvider([
    { toolCalls: [{ name: "read_file", args: { path: "hello.txt" } }] },
    { delta: ["unreachable"] },
  ]);
  const deps = { ...baseDeps(provider), terminal };
  const { surface, ready } = createTuiApp(deps);
  surface.start();
  try {
    const handles = await ready;
    handles.editor.onSubmit?.("read the file");

    await waitFor(() => handles.tui.render(80).join("\n").includes("read_file"));
    expect(handles.tui.render(80).join("\n")).toContain("y=allow");

    terminal.onInput?.(CTRL_C); // consumed by TuiSurface's listener, never reaches the card's onKey

    await waitFor(() => handles.tui.render(80).join("\n").includes("interrupted"));
    const frame = handles.tui.render(80).join("\n");
    expect(frame).not.toContain("y=allow"); // card hidden
    expect(frame).not.toContain("unreachable"); // the turn never resumed to stream this

    const events = deps.store.replay();
    const tr = events.find((e) => e.type === "tool_result") as any;
    expect(tr.ok).toBe(false); // ask() resolved deny
    const end = events.find((e) => e.type === "turn_end") as any;
    expect(end.stop).toBe("interrupt");
  } finally {
    surface.stop();
  }
});

test("/session lists sessions a fixture created, then /session <other-id> routes a subsequent turn into THAT session's file", async () => {
  new SessionStore("fixture-a").append({ id: "e1", ts: new Date().toISOString(), type: "user_message", text: "hi a" } as any);
  new SessionStore("fixture-b").append({ id: "e2", ts: new Date().toISOString(), type: "user_message", text: "hi b" } as any);

  const provider = new ScriptedToolProvider([{ delta: ["from origin"] }]);
  const deps = baseDeps(provider);
  const providerForFn = (() => new ScriptedToolProvider([{ delta: ["from fixture-b"] }])) as unknown as TuiAppDeps["providerForFn"];
  const { surface, ready } = createTuiApp({ ...deps, providerForFn });
  surface.start();
  try {
    const handles = await ready;
    const originId = handles.engineBox.current;

    handles.editor.onSubmit?.("/session");
    await waitFor(() => handles.tui.render(200).join("\n").includes("fixture-a"));
    let frame = handles.tui.render(200).join("\n");
    expect(frame).toContain("fixture-a");
    expect(frame).toContain("fixture-b");

    handles.editor.onSubmit?.("/session fixture-b");
    await waitFor(() => handles.engineBox.current !== originId);
    expect(handles.tui.render(200).join("\n")).toContain("resumed fixture-");

    handles.editor.onSubmit?.("say something");
    await waitFor(() => new SessionStore("fixture-b").replay().some((e) => e.type === "assistant_message"));

    const fixtureBEvents = new SessionStore("fixture-b").replay();
    expect(fixtureBEvents.some((e) => e.type === "assistant_message" && (e as any).text === "from fixture-b")).toBe(true);
  } finally {
    surface.stop();
  }
});

test("/escalate on the qwen profile swaps to sonnet — engineBox identity changes and the statusline updates", async () => {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  try {
    const provider = new ScriptedToolProvider([{ delta: ["ok"] }]);
    const deps = { ...baseDeps(provider), profile: getProfile("qwen")! };
    const providerForFn = (() => new ScriptedToolProvider([{ delta: ["ok2"] }])) as unknown as TuiAppDeps["providerForFn"];
    const { surface, ready } = createTuiApp({ ...deps, providerForFn });
    surface.start();
    try {
      const handles = await ready;
      const before = handles.engineBox.current;
      expect(handles.tui.render(200).join("\n")).toContain("qwen");

      handles.editor.onSubmit?.("/escalate");
      await waitFor(() => handles.engineBox.current !== before);

      const frame = handles.tui.render(200).join("\n");
      expect(frame).toContain("escalated to sonnet");
      expect(frame).toContain("sonnet");
    } finally {
      surface.stop();
    }
  } finally {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
  }
});


// --- Final-fix-round C1: the TUI must actually repaint a real terminal ---
//
// Both tests below are deliberately structured so the ONLY thing that could
// produce a new terminal write in the measured window is the component
// under test's own injected requestRender call — not the incidental render
// pi-tui's Editor triggers internally on its own text changes (confirmed by
// grep: editor.js calls `this.tui.requestRender()` from several of its own
// key handlers), and not the one-time initial render `tui.start()` itself
// schedules at boot (which fires AFTER onReady's synchronous mounting, so it
// already captures whatever's mounted regardless of any component's own
// wiring — a real gotcha that made an earlier draft of these tests pass
// even with the fix reverted). Every `waitFor` here polls ONLY
// `terminal.writes` — never `handles.tui.render()`/`renderNow()`.

test("(C1) a delta arriving well after the turn's initial (editor-incidental) render has settled still reaches the terminal on its own", async () => {
  const terminal = makeStubTerminal();
  // Real gap between deltas: long enough that the editor's own
  // submit-triggered render (Editor.setText("") -> tui.requestRender())
  // fires and fully settles BEFORE the second delta arrives, so nothing
  // else is pending when it does.
  const provider: Provider = {
    name: "delayed",
    async *stream(opts) {
      yield { type: "delta", text: "first-chunk " };
      await new Promise((r) => setTimeout(r, 80));
      if (opts.signal?.aborted) return;
      yield { type: "delta", text: "SECOND-UNIQUE-CHUNK" };
      if (!opts.signal?.aborted) yield { type: "done", stopReason: "end" };
    },
  };
  const deps = { ...baseDeps(provider), terminal };
  const { surface, ready } = createTuiApp(deps);
  surface.start();
  try {
    const handles = await ready;
    void handles;
    handles.editor.onSubmit?.("go");

    await waitFor(() => terminal.writes.join("").includes("first-chunk"));
    await new Promise((r) => setTimeout(r, 40)); // let that render fully quiesce — no pending timers left
    const settledWrites = terminal.writes.length;
    expect(terminal.writes.join("")).not.toContain("SECOND-UNIQUE-CHUNK");

    // Nothing else happens in this window (no editor call, no terminal
    // input) — only Transcript.appendDelta's own requestRender can make
    // this marker land.
    await waitFor(() => terminal.writes.join("").includes("SECOND-UNIQUE-CHUNK"), 600);
    expect(terminal.writes.length).toBeGreaterThan(settledWrites);
  } finally {
    surface.stop();
  }
});

test("(C1) Status.setActivity's own requestRender reaches the terminal with zero editor interaction", async () => {
  const terminal = makeStubTerminal();
  const provider = new ScriptedToolProvider([{ delta: ["unused"] }]);
  const deps = { ...baseDeps(provider), terminal };
  const { surface, ready } = createTuiApp(deps);
  surface.start();
  try {
    const handles = await ready;
    // Let the initial mount render (tui.start()'s own scheduled call, which
    // fires after onReady's synchronous mounting and so already captures
    // Status's content regardless of Status's own wiring) fully settle.
    await new Promise((r) => setTimeout(r, 40));
    const baseline = terminal.writes.length;
    expect(terminal.writes.join("")).not.toContain("tool round 5");

    // No editor.onSubmit anywhere in this test — a direct call on the
    // exposed handle is the ONLY thing that changes.
    handles.status.setActivity({ kind: "tool", round: 5 });

    await waitFor(() => terminal.writes.join("").includes("tool round 5"));
    expect(terminal.writes.length).toBeGreaterThan(baseline);
  } finally {
    surface.stop();
  }
});
