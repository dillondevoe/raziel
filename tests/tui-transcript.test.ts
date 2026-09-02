import { test, expect } from "bun:test";
import { Container, TuiMainScreen, type Terminal } from "@earendil-works/pi-tui";
import { Transcript } from "../src/tui/transcript";

const WIDTH = 80;

/** Recording stub Terminal — same headless pattern as tests/tui-surface.test.ts
 * (traced to docs/pi-tui-reference.md §8): `Terminal` is a plain interface, no
 * real PTY required. Only used by the one test below that needs the actual
 * TuiMainScreen differential-render engine (reference §2); every other test
 * exercises Transcript against a bare, renderer-less `Container`. */
function makeStubTerminal(): Terminal & { writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    start(_onInput: (data: string) => void, _onResize: () => void) {},
    stop() {},
    async drainInput() {},
    write(data: string) { writes.push(data); },
    get columns() { return WIDTH; },
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
}

test("scripted turn: user line, 3 deltas, end — final frame has text in order", () => {
  const parent = new Container();
  const transcript = new Transcript(parent);

  transcript.userLine("hello");
  transcript.beginAssistant("t1");
  transcript.appendDelta("t1", "foo ");
  transcript.appendDelta("t1", "bar ");
  transcript.appendDelta("t1", "baz");
  transcript.endAssistant("t1");

  const frame = parent.render(WIDTH).join("\n");
  const userIdx = frame.indexOf("hello");
  const assistantIdx = frame.indexOf("foo bar baz");
  expect(userIdx).toBeGreaterThanOrEqual(0);
  expect(assistantIdx).toBeGreaterThan(userIdx);
});

test("a delta containing an OSC title-set sequence renders with no ESC byte", () => {
  const parent = new Container();
  const transcript = new Transcript(parent);
  transcript.beginAssistant("t1");
  transcript.appendDelta("t1", "safe \x1b]0;evil\x07 text");
  transcript.endAssistant("t1");

  const frame = parent.render(WIDTH).join("\n");
  expect(frame.includes("\x1b")).toBe(false);
  expect(frame).toContain("safe");
  expect(frame).toContain("text");
});

test("toolCard renders tool name + risk + ok mark for request and result", () => {
  const parent = new Container();
  const transcript = new Transcript(parent);

  transcript.toolCard({ tool: "read_file", risk: "low", phase: "request" });
  transcript.toolCard({ tool: "read_file", ok: true, phase: "result", output: "contents" });

  const frame = parent.render(WIDTH).join("\n");
  expect(frame).toContain("read_file");
  expect(frame).toContain("low");
  expect(frame).toContain("✓"); // ✓
});

test("toolCard failure renders a distinct not-ok mark", () => {
  const parent = new Container();
  const transcript = new Transcript(parent);

  transcript.toolCard({ tool: "run_command", ok: false, phase: "result" });

  const frame = parent.render(WIDTH).join("\n");
  expect(frame).toContain("✗"); // ✗
});

test("tool output over 400 chars is truncated with a session-log tail", () => {
  const parent = new Container();
  const transcript = new Transcript(parent);
  const longOutput = "x".repeat(500);

  transcript.toolCard({ tool: "run_command", ok: true, phase: "result", output: longOutput });

  const frame = parent.render(WIDTH).join("\n");
  expect(frame).toContain("… (+100 chars, in session log)");
  expect(frame).not.toContain("x".repeat(500));
});

test("truncation is surrogate-safe: an emoji straddling the cut boundary is never split", () => {
  const parent = new Container();
  const transcript = new Transcript(parent);
  // 399 "x" + one astral emoji (surrogate pair) + trailing text — the emoji
  // sits exactly on the naive 400-UTF-16-code-unit cut boundary.
  const longOutput = "x".repeat(399) + "\u{1F600}" + "more text after";

  transcript.toolCard({ tool: "run_command", ok: true, phase: "result", output: longOutput });

  const frame = parent.render(WIDTH).join("\n");
  // No lone high surrogate anywhere in the frame.
  expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(frame)).toBe(false);
  expect(frame).toContain("… (+15 chars, in session log)");
});

test("100-line transcript keeps follow-at-end — last line visible in final frame", () => {
  const parent = new Container();
  const transcript = new Transcript(parent);

  for (let i = 0; i < 100; i++) transcript.userLine(`line ${i}`);

  const lines = parent.render(WIDTH);
  const lastNonBlank = [...lines].reverse().find((l) => l.trim() !== "");
  expect(lastNonBlank).toContain("line 99");
});

test("interruptMark finalizes the open turn and appends a visible marker", () => {
  const parent = new Container();
  const transcript = new Transcript(parent);
  transcript.beginAssistant("t1");
  transcript.appendDelta("t1", "partial");
  transcript.interruptMark("t1");

  const frame = parent.render(WIDTH).join("\n");
  expect(frame).toContain("partial");
  expect(frame).toContain("interrupted");
});

test("errorLine renders a visible, sanitized error marker", () => {
  const parent = new Container();
  const transcript = new Transcript(parent);
  transcript.errorLine("boom \x1b[31mred\x1b[0m");

  const frame = parent.render(WIDTH).join("\n");
  expect(frame).toContain("boom");
  expect(frame.includes("\x1b")).toBe(false);
});

test("streaming: 50 appendDelta calls cause incremental redraws, not 50 full-frame redraws", () => {
  const terminal = makeStubTerminal();
  const tui = new TuiMainScreen(terminal);
  const transcript = new Transcript(tui);
  tui.start();

  // Padding history so a full redraw would be an obviously bigger write.
  for (let i = 0; i < 20; i++) transcript.userLine(`history ${i}`);
  transcript.beginAssistant("t1");
  tui.renderNow(true); // establish the differential baseline (reference §2)

  const fullRedrawsBefore = tui.fullRedraws;
  for (let i = 0; i < 50; i++) {
    transcript.appendDelta("t1", "x");
    tui.renderNow(); // force=false: exercises the differential path only
  }

  // Reference §2: TuiMainScreen only does a full clear+redraw on a width/height
  // change, or when content shrinks — otherwise it "moves the cursor to the
  // first changed line and rewrites only changed lines onward". Mutating the
  // single open Text component in place (rather than adding a child per
  // delta) is what keeps every one of these 50 renders on that differential
  // path. Zero *additional* full redraws across 50 deltas is the behavioral
  // proof.
  expect(tui.fullRedraws).toBe(fullRedrawsBefore);
  tui.stop();
});
