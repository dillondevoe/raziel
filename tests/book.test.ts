import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderBook, listSessions } from "../src/book";
import { SessionStore, razielHome } from "../src/session";
import { mkEvent, type SessionEvent } from "../src/events";

beforeEach(() => { process.env.RAZIEL_HOME = mkdtempSync(join(tmpdir(), "raziel-book-test-")); });

test("renderBook: empty log reads as an empty book", () => {
  expect(renderBook([])).toContain("empty");
});

test("renderBook: normal turn shows user line, assistant text, and end marker", () => {
  const events: SessionEvent[] = [
    { ...mkEvent("user_message", { text: "hello raziel" }), ts: "2026-08-31T12:00:00.000Z" },
    { ...mkEvent("assistant_message", { turn: "t1", text: "hello, seeker" }), ts: "2026-08-31T12:00:01.000Z" },
    { ...mkEvent("turn_end", { turn: "t1", stop: "end" }), ts: "2026-08-31T12:00:02.000Z" },
  ];
  const out = renderBook(events);
  expect(out).toContain("hello raziel");
  expect(out).toContain("hello, seeker");
  expect(out).toContain("end 12:00:02");
  expect(out).not.toContain("interrupted");
  expect(out).not.toContain("error");
});

test("renderBook: interrupted turn shows partial text with a distinct marker", () => {
  const events: SessionEvent[] = [
    { ...mkEvent("user_message", { text: "tell me a story" }), ts: "2026-08-31T12:00:03.000Z" },
    { ...mkEvent("assistant_message", { turn: "t2", text: "Once upon a t" }), ts: "2026-08-31T12:00:04.000Z" },
    { ...mkEvent("turn_end", { turn: "t2", stop: "interrupt" }), ts: "2026-08-31T12:00:05.000Z" },
  ];
  const out = renderBook(events);
  expect(out).toContain("tell me a story");
  expect(out).toContain("interrupted");
  expect(out).toContain("Once upon a t");
  expect(out).toContain("interrupt 12:00:05");
});

test("renderBook: errored turn shows the error message distinctly", () => {
  const events: SessionEvent[] = [
    { ...mkEvent("user_message", { text: "do a thing" }), ts: "2026-08-31T12:00:06.000Z" },
    { ...mkEvent("error", { turn: "t3", message: "network exploded" }), ts: "2026-08-31T12:00:07.000Z" },
    { ...mkEvent("turn_end", { turn: "t3", stop: "error" }), ts: "2026-08-31T12:00:08.000Z" },
  ];
  const out = renderBook(events);
  expect(out).toContain("do a thing");
  expect(out).toContain("error: network exploded");
  expect(out).toContain("error 12:00:08");
});

test("renderBook: empty interrupt (turn_end only, no assistant text) renders without crashing", () => {
  const events: SessionEvent[] = [
    { ...mkEvent("user_message", { text: "ctrl-c immediately" }), ts: "2026-08-31T12:00:09.000Z" },
    { ...mkEvent("turn_end", { turn: "t4", stop: "interrupt" }), ts: "2026-08-31T12:00:10.000Z" },
  ];
  const out = renderBook(events);
  expect(out).toContain("ctrl-c immediately");
  expect(out).toContain("interrupted");
  expect(out).toContain("interrupt 12:00:10");
});

test("renderBook: tool events render one line each with tool name and argsHash/risk", () => {
  const events: SessionEvent[] = [
    { ...mkEvent("user_message", { text: "run a tool" }), ts: "2026-08-31T12:00:11.000Z" },
    { ...mkEvent("tool_request", { turn: "t5", tool: "read_file", args: { p: "/tmp" }, requestId: "r1", provenance: "provider_structured", argsHash: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789" }), ts: "2026-08-31T12:00:12.000Z" },
    { ...mkEvent("approval_request", { turn: "t5", requestId: "r1", tool: "read_file", argsHash: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789", risk: "medium" }), ts: "2026-08-31T12:00:12.100Z" },
    { ...mkEvent("approval_decision", { requestId: "r1", decision: "allow" }), ts: "2026-08-31T12:00:12.200Z" },
    { ...mkEvent("tool_result", { turn: "t5", tool: "read_file", ok: true, output: "file contents", requestId: "r1", taint: "tool_output" }), ts: "2026-08-31T12:00:12.300Z" },
    { ...mkEvent("assistant_message", { turn: "t5", text: "done" }), ts: "2026-08-31T12:00:13.000Z" },
    { ...mkEvent("turn_end", { turn: "t5", stop: "end" }), ts: "2026-08-31T12:00:14.000Z" },
  ];
  const out = renderBook(events);
  expect(out).toContain("run a tool");
  expect(out).toContain("read_file");
  expect(out).toContain("medium");
  expect(out).toContain("abcdef01");
  expect(out).toContain("allow");
  expect(out).toContain("done");
});

test("renderBook: tool_result with ok:false renders with ✗ marker", () => {
  const events: SessionEvent[] = [
    { ...mkEvent("user_message", { text: "run a tool" }), ts: "2026-08-31T12:00:11.000Z" },
    { ...mkEvent("tool_request", { turn: "t5", tool: "read_file", args: {}, requestId: "r1", provenance: "provider_structured", argsHash: "ab".repeat(32) }), ts: "2026-08-31T12:00:12.000Z" },
    { ...mkEvent("tool_result", { turn: "t5", tool: "read_file", ok: false, output: "file not found", requestId: "r1", taint: "tool_output" }), ts: "2026-08-31T12:00:12.300Z" },
    { ...mkEvent("assistant_message", { turn: "t5", text: "failed" }), ts: "2026-08-31T12:00:13.000Z" },
    { ...mkEvent("turn_end", { turn: "t5", stop: "end" }), ts: "2026-08-31T12:00:14.000Z" },
  ];
  const out = renderBook(events);
  expect(out).toContain("read_file");
  expect(out).toContain("✗");
});

test("renderBook: OSC/control chars in tool output are sanitized", () => {
  const events: SessionEvent[] = [
    { ...mkEvent("user_message", { text: "run a tool" }), ts: "2026-08-31T12:00:11.000Z" },
    { ...mkEvent("tool_request", { turn: "t5", tool: "read_file", args: {}, requestId: "r1", provenance: "provider_structured", argsHash: "ab".repeat(32) }), ts: "2026-08-31T12:00:12.000Z" },
    { ...mkEvent("tool_result", { turn: "t5", tool: "read_file", ok: true, output: "file\x1b]52;c;evil\x07contents", requestId: "r1", taint: "tool_output" }), ts: "2026-08-31T12:00:12.300Z" },
    { ...mkEvent("assistant_message", { turn: "t5", text: "done" }), ts: "2026-08-31T12:00:13.000Z" },
    { ...mkEvent("turn_end", { turn: "t5", stop: "end" }), ts: "2026-08-31T12:00:14.000Z" },
  ];
  const out = renderBook(events);
  expect(out).not.toContain("\x1b");
  expect(out).toContain("filecontents");
});

test("renderBook: OSC/control chars in tool name are sanitized", () => {
  const events: SessionEvent[] = [
    { ...mkEvent("user_message", { text: "run a tool" }), ts: "2026-08-31T12:00:11.000Z" },
    { ...mkEvent("tool_request", { turn: "t5", tool: "read\x1b]52;c;evil\x07file", args: {}, requestId: "r1", provenance: "provider_structured", argsHash: "ab".repeat(32) }), ts: "2026-08-31T12:00:12.000Z" },
    { ...mkEvent("assistant_message", { turn: "t5", text: "done" }), ts: "2026-08-31T12:00:13.000Z" },
    { ...mkEvent("turn_end", { turn: "t5", stop: "end" }), ts: "2026-08-31T12:00:14.000Z" },
  ];
  const out = renderBook(events);
  expect(out).not.toContain("\x1b");
  expect(out).toContain("readfile");
});

test("renderBook: unknown/torn event types are skipped gracefully", () => {
  const events: SessionEvent[] = [
    { ...mkEvent("user_message", { text: "run a tool" }), ts: "2026-08-31T12:00:11.000Z" },
    { ...mkEvent("tool_request", { turn: "t5", tool: "ls", args: {}, requestId: "r1", provenance: "provider_structured", argsHash: "ab".repeat(32) }), ts: "2026-08-31T12:00:12.000Z" },
    { ...mkEvent("assistant_message", { turn: "t5", text: "done" }), ts: "2026-08-31T12:00:13.000Z" },
    { ...mkEvent("turn_end", { turn: "t5", stop: "end" }), ts: "2026-08-31T12:00:14.000Z" },
  ];
  expect(() => renderBook(events)).not.toThrow();
  const out = renderBook(events);
  expect(out).toContain("run a tool");
  expect(out).toContain("done");
});

test("listSessions: no sessions reads as an empty book", () => {
  expect(listSessions()).toContain("empty");
});

test("renderBook: hostile ANSI/OSC bytes in user text are sanitized", () => {
  const events: SessionEvent[] = [
    { ...mkEvent("user_message", { text: "hi\x1b]0;PWNED\x07there" }), ts: "2026-08-31T12:00:00.000Z" },
    { ...mkEvent("assistant_message", { turn: "t1", text: "ok\x1b[2Jclean" }), ts: "2026-08-31T12:00:01.000Z" },
    { ...mkEvent("turn_end", { turn: "t1", stop: "end" }), ts: "2026-08-31T12:00:02.000Z" },
  ];
  const out = renderBook(events);
  expect(out).not.toContain("\x1b");
  expect(out).toContain("hithere");
  expect(out).toContain("okclean");
});

test("renderBook: hostile bytes in an error message are sanitized", () => {
  const events: SessionEvent[] = [
    { ...mkEvent("user_message", { text: "do a thing" }), ts: "2026-08-31T12:00:06.000Z" },
    { ...mkEvent("error", { turn: "t3", message: "boom\x1b]52;c;evil\x07tail" }), ts: "2026-08-31T12:00:07.000Z" },
    { ...mkEvent("turn_end", { turn: "t3", stop: "error" }), ts: "2026-08-31T12:00:08.000Z" },
  ];
  const out = renderBook(events);
  expect(out).not.toContain("\x1b");
  expect(out).toContain("boomtail");
});

test("listSessions: hostile bytes in a preview are sanitized", () => {
  new SessionStore("2026-03-03T00-00-00Z").append(mkEvent("user_message", { text: "hi\x1b]0;PWNED\x07there" }));
  const out = listSessions();
  expect(out).not.toContain("\x1b");
  expect(out).toContain("hithere");
});

test("listSessions: a foreign/malformed session filename is skipped, not crashed on (F1 regression)", () => {
  new SessionStore("2026-01-01T00-00-00Z").append(mkEvent("user_message", { text: "first session ever" }));
  new SessionStore("2026-02-02T00-00-00Z").append(mkEvent("user_message", { text: "second session" }));
  // Planted directly on disk, bypassing SessionStore's validated constructor —
  // simulates a non-raziel writer (SyncThing sync, backup restore): F1's own
  // threat model, now landing a filename that fails id validation.
  writeFileSync(join(razielHome(), "sessions", "weird name; rm -rf.jsonl"), "");
  expect(() => listSessions()).not.toThrow();
  const out = listSessions();
  expect(out).toContain("2026-01-01T00-00-00Z");
  expect(out).toContain("2026-02-02T00-00-00Z");
  expect(out).toContain("(+1 unlistable session files ignored)");
  expect(out).not.toContain("weird name");
  expect(out).not.toContain("rm -rf");
});

test("listSessions: lists newest first with event count and a user-message preview", () => {
  new SessionStore("2026-01-01T00-00-00Z").append(mkEvent("user_message", { text: "first session ever" }));
  const s2 = new SessionStore("2026-02-02T00-00-00Z");
  s2.append(mkEvent("user_message", { text: "second session" }));
  s2.append(mkEvent("assistant_message", { turn: "t1", text: "hi" }));
  const out = listSessions();
  const lines = out.trim().split("\n");
  expect(lines[0]).toContain("2026-02-02T00-00-00Z");
  expect(lines[0]).toContain("second session");
  expect(lines[0]).toContain("2");
  expect(lines[1]).toContain("2026-01-01T00-00-00Z");
  expect(lines[1]).toContain("first session ever");
});
