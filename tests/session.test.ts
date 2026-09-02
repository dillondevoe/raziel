import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/session";
import { mkEvent } from "../src/events";

beforeEach(() => { process.env.RAZIEL_HOME = mkdtempSync(join(tmpdir(), "raziel-test-")); });

test("append then replay round-trips events in order", () => {
  const s = new SessionStore("t1");
  const a = mkEvent("user_message", { text: "hello" });
  const b = mkEvent("assistant_message", { turn: "turn1", text: "hi!" });
  s.append(a); s.append(b);
  const out = new SessionStore("t1").replay();
  expect(out).toEqual([a, b]);
});

test("replay of missing session is empty, torn last line is skipped", () => {
  expect(new SessionStore("nope").replay()).toEqual([]);
  const s = new SessionStore("torn");
  s.append(mkEvent("user_message", { text: "ok" }));
  appendFileSync(s.path, '{"type":"assistant_mess');  // simulated crash mid-write
  expect(new SessionStore("torn").replay().length).toBe(1);
});

test("list returns ids newest first", () => {
  new SessionStore("2026-01-01T00-00-00Z").append(mkEvent("user_message", { text: "a" }));
  new SessionStore("2026-02-02T00-00-00Z").append(mkEvent("user_message", { text: "b" }));
  expect(SessionStore.list()[0]).toBe("2026-02-02T00-00-00Z");
});

test("list orders by mtime, not lexicographically (touch order matters)", () => {
  new SessionStore("b-name").append(mkEvent("user_message", { text: "first" }));
  new SessionStore("a-name").append(mkEvent("user_message", { text: "second" }));
  expect(SessionStore.list()[0]).toBe("a-name");
});
