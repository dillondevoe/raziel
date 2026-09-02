import { test, expect } from "bun:test";
import { makeSigintHandler } from "../src/cli";

test("first tap aborts in-flight turn without clearing ref; second mid-finish tap re-aborts, no exit", () => {
  const ctl = new AbortController();
  const ref = { current: ctl as AbortController | null };
  let exited = -1;
  const h = makeSigintHandler({ signalRef: ref, isClosed: () => false, exit: (c) => { exited = c; }, write: () => {} });
  h();
  expect(ctl.signal.aborted).toBe(true);
  expect(ref.current).toBe(ctl);       // NOT cleared by the handler (single-clearer rule)
  h();                                  // turn still finishing — must not exit
  expect(exited).toBe(-1);
});

test("tap when idle exits 0 with farewell", () => {
  let exited = -1; let out = "";
  const h = makeSigintHandler({ signalRef: { current: null }, isClosed: () => false, exit: (c) => { exited = c; }, write: (s) => { out += s; } });
  h();
  expect(exited).toBe(0);
  expect(out).toContain("bye");
});
