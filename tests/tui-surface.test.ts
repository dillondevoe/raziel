import { test, expect } from "bun:test";
import type { Terminal } from "@earendil-works/pi-tui";
import { TuiSurface, wantsTui } from "../src/tui/surface";

const CTRL_C = "\x03";

type StubTerminal = Terminal & { calls: string[]; onInput?: (data: string) => void };

/** Recording stub Terminal — pattern from docs/pi-tui-reference.md §8's headless
 * smoke test: `Terminal` is a plain interface, no real PTY required. Every
 * method call and write() payload is logged so lifecycle assertions (alt-screen
 * enter/exit sequences, start/stop calls) can be made without a real terminal. */
function makeStubTerminal(): StubTerminal {
  const calls: string[] = [];
  const stub: StubTerminal = {
    calls,
    onInput: undefined,
    start(onInput: (data: string) => void, _onResize: () => void) {
      stub.onInput = onInput;
      calls.push("start");
    },
    stop() { calls.push("stop"); },
    async drainInput() {},
    write(data: string) { calls.push(`write:${data}`); },
    get columns() { return 80; },
    get rows() { return 24; },
    get kittyProtocolActive() { return false; },
    moveBy(_lines: number) {},
    hideCursor() { calls.push("hideCursor"); },
    showCursor() { calls.push("showCursor"); },
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    setTitle(_title: string) {},
    setProgress(_active: boolean) {},
  };
  return stub;
}

test("start() enters alt-screen and puts the terminal into input/raw mode", () => {
  const terminal = makeStubTerminal();
  const surface = new TuiSurface({ terminal, onInterrupt: () => {}, onQuit: () => {}, isStreaming: () => false });

  surface.start();

  // Raw mode itself is a ProcessTerminal implementation detail (guarded
  // process.stdin.setRawMode call) invisible to the generic Terminal
  // interface — terminal.start() being invoked is the observable stand-in.
  expect(terminal.calls).toContain("start");
  expect(terminal.calls.some((c) => c.startsWith("write:") && c.includes("\x1b[?1049h"))).toBe(true);
  expect(surface.running).toBe(true);
});

test("ctrl-c while a turn is streaming fires onInterrupt once, surface keeps running", () => {
  const terminal = makeStubTerminal();
  let interrupted = 0;
  let quit = 0;
  const surface = new TuiSurface({
    terminal,
    onInterrupt: () => { interrupted++; },
    onQuit: () => { quit++; },
    isStreaming: () => true,
  });
  surface.start();

  terminal.onInput?.(CTRL_C);

  expect(interrupted).toBe(1);
  expect(quit).toBe(0);
  expect(surface.running).toBe(true);
});

test("ctrl-c while idle fires onQuit", () => {
  const terminal = makeStubTerminal();
  let interrupted = 0;
  let quit = 0;
  const surface = new TuiSurface({
    terminal,
    onInterrupt: () => { interrupted++; },
    onQuit: () => { quit++; },
    isStreaming: () => false,
  });
  surface.start();

  terminal.onInput?.(CTRL_C);

  expect(quit).toBe(1);
  expect(interrupted).toBe(0);
});

test("stop() restores the terminal (inverse control sequences), and a second stop() is a no-op", () => {
  const terminal = makeStubTerminal();
  const surface = new TuiSurface({ terminal, onInterrupt: () => {}, onQuit: () => {}, isStreaming: () => false });
  surface.start();

  surface.stop();

  expect(terminal.calls).toContain("stop");
  expect(terminal.calls.some((c) => c.startsWith("write:") && c.includes("\x1b[?1049l"))).toBe(true);
  expect(surface.running).toBe(false);

  const callsAfterFirstStop = terminal.calls.length;
  surface.stop();

  expect(terminal.calls.length).toBe(callsAfterFirstStop);
  expect(surface.running).toBe(false);
});

test("stop() is safe when the surface was never started", () => {
  const surface = new TuiSurface({ onInterrupt: () => {}, onQuit: () => {}, isStreaming: () => false });
  expect(() => surface.stop()).not.toThrow();
  expect(surface.running).toBe(false);
});

test("start() installs process crash handlers exactly once; stop() removes them", () => {
  const terminal = makeStubTerminal();
  const before = {
    uncaught: process.listenerCount("uncaughtException"),
    unhandled: process.listenerCount("unhandledRejection"),
    exit: process.listenerCount("exit"),
  };
  const surface = new TuiSurface({ terminal, onInterrupt: () => {}, onQuit: () => {}, isStreaming: () => false });

  surface.start();
  surface.start(); // idempotent — must not double-register

  expect(process.listenerCount("uncaughtException")).toBe(before.uncaught + 1);
  expect(process.listenerCount("unhandledRejection")).toBe(before.unhandled + 1);
  expect(process.listenerCount("exit")).toBe(before.exit + 1);

  surface.stop();

  expect(process.listenerCount("uncaughtException")).toBe(before.uncaught);
  expect(process.listenerCount("unhandledRejection")).toBe(before.unhandled);
  expect(process.listenerCount("exit")).toBe(before.exit);
});

test("wantsTui() is false under RAZIEL_PLAIN=1", () => {
  const prev = process.env.RAZIEL_PLAIN;
  process.env.RAZIEL_PLAIN = "1";
  try {
    expect(wantsTui()).toBe(false);
  } finally {
    if (prev === undefined) delete process.env.RAZIEL_PLAIN;
    else process.env.RAZIEL_PLAIN = prev;
  }
});
