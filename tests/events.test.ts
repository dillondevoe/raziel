import { test, expect } from "bun:test";
import { mkEvent, isValidEvent } from "../src/events";

test("mkEvent stamps machine id and ISO timestamp", () => {
  const e = mkEvent("user_message", { text: "hi" });
  expect(e.type).toBe("user_message");
  if (e.type === "user_message") expect(e.text).toBe("hi");
  expect(e.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(new Date(e.ts).toISOString()).toBe(e.ts);
});

test("two events never share an id", () => {
  const a = mkEvent("user_message", { text: "a" });
  const b = mkEvent("user_message", { text: "b" });
  expect(a.id).not.toBe(b.id);
});

test("isValidEvent: accepts a well-formed event of every known type", () => {
  expect(isValidEvent(mkEvent("user_message", { text: "hi" }))).toBe(true);
  expect(isValidEvent(mkEvent("assistant_message", { turn: "t1", text: "hi" }))).toBe(true);
  expect(isValidEvent(mkEvent("turn_end", { turn: "t1", stop: "end" }))).toBe(true);
  expect(isValidEvent(mkEvent("error", { turn: "t1", message: "boom" }))).toBe(true);
  expect(isValidEvent(mkEvent("error", { message: "boom" }))).toBe(true); // turn is optional
  expect(isValidEvent(mkEvent("tool_request", { turn: "t1", tool: "ls", args: {} }))).toBe(true);
  expect(isValidEvent(mkEvent("approval_request", { turn: "t1", requestId: "r1" }))).toBe(true);
  expect(isValidEvent(mkEvent("approval_decision", { requestId: "r1", decision: "allow" }))).toBe(true);
  expect(isValidEvent(mkEvent("tool_result", { turn: "t1", tool: "ls", ok: true, output: "" }))).toBe(true);
});

test("isValidEvent: rejects an unknown type", () => {
  expect(isValidEvent({ id: "x", ts: "2026-01-01T00:00:00.000Z", type: "evil" })).toBe(false);
});

test("isValidEvent: rejects a known type missing required fields", () => {
  expect(isValidEvent({ id: "x", ts: "2026-01-01T00:00:00.000Z", type: "assistant_message" })).toBe(false);
});

test("isValidEvent: rejects a known type with wrong-typed fields", () => {
  expect(isValidEvent({
    id: "x", ts: "2026-01-01T00:00:00.000Z", type: "user_message", text: 123,
  })).toBe(false);
});

test("isValidEvent: rejects missing base id/ts or non-object input", () => {
  expect(isValidEvent({ type: "user_message", text: "hi" })).toBe(false);
  expect(isValidEvent(null)).toBe(false);
  expect(isValidEvent("not an object")).toBe(false);
  expect(isValidEvent(42)).toBe(false);
});
