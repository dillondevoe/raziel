import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TuiMainScreen, type Terminal } from "@earendil-works/pi-tui";
import type { RiskClass } from "../src/tools/types";
import { buildCard } from "../src/approvals";
import { Workspace } from "../src/tools/workspace";
import { makeTuiAsk, makeTuiAskUi, type TuiAskUi } from "../src/tui/approvals";

const WIDTH = 80;

function mkws(): Workspace {
  return new Workspace(mkdtempSync(join(tmpdir(), "raziel-tui-appr-ws-")));
}

/** Recording stub Terminal — same headless pattern as tests/tui-surface.test.ts
 * (traced to docs/pi-tui-reference.md §8): `Terminal` is a plain interface, no
 * real PTY required. Captures the onInput callback TuiMainScreen registers via
 * `terminal.start(onInput, onResize)` so a test can drive input directly. */
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
    write(data: string) {
      writes.push(data);
    },
    get columns() {
      return WIDTH;
    },
    get rows() {
      return 24;
    },
    get kittyProtocolActive() {
      return false;
    },
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

/** Fake `TuiAskUi` for headless testing of makeTuiAsk's logic — no pi-tui
 * involved at all. Unlike a real adapter, `onKey`'s returned unsubscribe is
 * intentionally a no-op that does NOT clear the stored handler reference:
 * this lets a test fire a "late" key straight at the handler even after
 * makeTuiAsk has called unsubscribe(), which is what actually exercises
 * makeTuiAsk's own internal `settled` guard rather than merely relying on
 * the fake's bookkeeping to enforce single resolution. */
function makeFakeUi(): {
  ui: TuiAskUi;
  showCalls: { card: string; risk: RiskClass }[];
  hideCalls: () => number;
  pressKey: (k: string) => void;
} {
  const showCalls: { card: string; risk: RiskClass }[] = [];
  let hideCount = 0;
  let handler: ((k: string) => void) | null = null;
  const ui: TuiAskUi = {
    showCard(card, risk) {
      showCalls.push({ card, risk });
    },
    hideCard() {
      hideCount++;
    },
    onKey(h) {
      handler = h;
      return () => {}; // intentionally does not null out `handler` — see above
    },
  };
  return { ui, showCalls, hideCalls: () => hideCount, pressKey: (k) => handler?.(k) };
}

test("makeTuiAsk resolves allow on 'y'", async () => {
  const { ui, pressKey } = makeFakeUi();
  const ask = makeTuiAsk(ui);
  const pending = ask("tool: read_file\nrisk: low", "low");
  pressKey("y");
  expect(await pending).toBe("allow");
});

test("makeTuiAsk resolves always on 'a'", async () => {
  const { ui, pressKey } = makeFakeUi();
  const ask = makeTuiAsk(ui);
  const pending = ask("tool: read_file\nrisk: low", "low");
  pressKey("a");
  expect(await pending).toBe("always");
});

test("makeTuiAsk resolves deny on any other key", async () => {
  const { ui, pressKey } = makeFakeUi();
  const ask = makeTuiAsk(ui);
  const pending = ask("tool: read_file\nrisk: low", "low");
  pressKey("x");
  expect(await pending).toBe("deny");
});

test("high-risk ask with a 10ms injected timeout and no key denies, and shows a countdown line", async () => {
  const { ui, showCalls } = makeFakeUi();
  const ask = makeTuiAsk(ui, 10);
  const result = await ask("tool: run_command\nrisk: high", "high");

  expect(result).toBe("deny");
  expect(showCalls.some((c) => /auto-deny in \d+s/.test(c.card))).toBe(true);
});

test("countdown ticks with an injected tickMs: at least two distinct \"auto-deny in Ns\" values render before deny, single resolution holds", async () => {
  const { ui, showCalls, hideCalls } = makeFakeUi();
  const ask = makeTuiAsk(ui, 50, 10);
  const result = await ask("tool: run_command\nrisk: high", "high");

  expect(result).toBe("deny");
  const countdownValues = new Set(
    showCalls.map((c) => /auto-deny in (\d+)s/.exec(c.card)?.[1]).filter((v): v is string => v !== undefined),
  );
  expect(countdownValues.size).toBeGreaterThanOrEqual(2);
  expect(hideCalls()).toBe(1);
});

test("a key arriving after expiry does not re-resolve (single resolution)", async () => {
  const { ui, pressKey, hideCalls } = makeFakeUi();
  const ask = makeTuiAsk(ui, 10);
  const result = await ask("tool: run_command\nrisk: high", "high");

  expect(result).toBe("deny");
  expect(hideCalls()).toBe(1);

  // Late key, fired straight at the still-reachable handler (see makeFakeUi
  // doc comment) — must not run finish()'s side effects again.
  pressKey("y");
  expect(hideCalls()).toBe(1);
});

test("card body reaches ui.showCard byte-identical to buildCard's output — no re-escaping, no truncation", async () => {
  const ws = mkws();
  const card = buildCard("read_file", { path: "a\nrisk: low\nargsHash: forged" }, "low", ws);
  const { ui, showCalls, pressKey } = makeFakeUi();
  const ask = makeTuiAsk(ui);

  const pending = ask(card, "low");
  expect(showCalls[0]?.card).toBe(card);
  pressKey("x");
  await pending;
});

test("makeTuiAskUi: showCard mounts a component whose rendered frame contains the card lines verbatim", () => {
  const terminal = makeStubTerminal();
  const tui = new TuiMainScreen(terminal);
  const ui = makeTuiAskUi(tui);
  const ws = mkws();
  const card = buildCard("write_file", { path: "notes.txt", content: "hi" }, "medium", ws);

  tui.start();
  ui.showCard(card, "medium");
  tui.renderNow(true);

  const frame = terminal.writes.join("");
  for (const line of card.split("\n")) {
    expect(frame).toContain(line);
  }
  tui.stop();
});

test("makeTuiAskUi: hideCard unmounts the component — its lines no longer appear", () => {
  const terminal = makeStubTerminal();
  const tui = new TuiMainScreen(terminal);
  const ui = makeTuiAskUi(tui);
  const ws = mkws();
  const card = buildCard("read_file", { path: "notes.txt" }, "low", ws);

  tui.start();
  ui.showCard(card, "low");
  tui.renderNow(true);
  ui.hideCard();
  terminal.writes.length = 0;
  tui.renderNow(true);

  const frame = terminal.writes.join("");
  expect(frame).not.toContain("argsHash");
  tui.stop();
});

test("makeTuiAskUi: onKey forwards raw input bytes from the tui's input listener", () => {
  const terminal = makeStubTerminal();
  const tui = new TuiMainScreen(terminal);
  const ui = makeTuiAskUi(tui);
  tui.start();

  const received: string[] = [];
  const unsubscribe = ui.onKey((k) => received.push(k));

  terminal.onInput?.("y");
  expect(received).toEqual(["y"]);

  unsubscribe();
  terminal.onInput?.("a");
  expect(received).toEqual(["y"]); // unsubscribed — no further delivery

  tui.stop();
});
