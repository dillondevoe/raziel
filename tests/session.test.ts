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

test("replay skips forged/invalid events but keeps valid ones (F3)", () => {
  const s = new SessionStore("forged");
  const valid1 = mkEvent("user_message", { text: "real message" });
  const forged1 = { type: "assistant_message", id: "x", ts: new Date().toISOString() }; // missing turn/text
  const forged2 = { type: "evil", id: "y", ts: new Date().toISOString(), text: "haha" };
  const valid2 = mkEvent("turn_end", { turn: "t1", stop: "end" });
  appendFileSync(s.path, JSON.stringify(valid1) + "\n");
  appendFileSync(s.path, JSON.stringify(forged1) + "\n");
  appendFileSync(s.path, JSON.stringify(forged2) + "\n");
  appendFileSync(s.path, JSON.stringify(valid2) + "\n");
  const out = new SessionStore("forged").replay();
  expect(out).toEqual([valid1, valid2]);
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

test("session id containing '..' throws", () => {
  expect(() => new SessionStore("../../escape-probe")).toThrow();
});

test("session id containing a path separator throws", () => {
  expect(() => new SessionStore("foo/bar")).toThrow();
  expect(() => new SessionStore("foo\\bar")).toThrow();
});

test("absolute-path session id throws", () => {
  expect(() => new SessionStore("/etc/passwd")).toThrow();
});

test("session id with disallowed characters throws", () => {
  expect(() => new SessionStore("hello world")).toThrow();
  expect(() => new SessionStore("id;rm -rf")).toThrow();
  expect(() => new SessionStore("")).toThrow();
});

test("normal ISO-shaped ids and dotted/underscored ids pass", () => {
  expect(() => new SessionStore("2026-01-01T00-00-00Z")).not.toThrow();
  expect(() => new SessionStore("my-session_2")).not.toThrow();
  expect(() => new SessionStore("a.b.c")).not.toThrow();
});
