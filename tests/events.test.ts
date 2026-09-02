import { test, expect } from "bun:test";
import { mkEvent, isValidEvent } from "../src/events";
import { canonicalJson, argsHash } from "../src/tools/types";

test("canonicalJson is key-order stable and argsHash matches recomputation", () => {
  expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  expect(argsHash("t", { b: 1, a: 2 })).toBe(argsHash("t", { a: 2, b: 1 }));
  expect(argsHash("t", { a: 1 })).not.toBe(argsHash("u", { a: 1 }));
});

test("canonicalJson drops undefined object properties; arrays convert undefined to null", () => {
  expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  expect(canonicalJson([1, undefined, 2])).toBe('[1,null,2]');
  expect(argsHash("t", { a: undefined, b: 1 })).toBe(argsHash("t", { b: 1 }));
  expect(JSON.parse(canonicalJson({ a: undefined, b: 1 }))).toEqual({ b: 1 });
  expect(JSON.parse(canonicalJson([1, undefined, 2]))).toEqual([1, null, 2]);
});

test("v2 tool events validate; forged/missing fields rejected", () => {
  const ok = mkEvent("tool_request", { turn: "t", tool: "read_file", args: { p: 1 }, requestId: "r1", provenance: "provider_structured", argsHash: "ab".repeat(32) });
  expect(isValidEvent(JSON.parse(JSON.stringify(ok)))).toBe(true);
  const forged = { ...JSON.parse(JSON.stringify(ok)), provenance: "text_parsed" };
  expect(isValidEvent(forged)).toBe(false);
  const noHash = { ...JSON.parse(JSON.stringify(ok)) }; delete (noHash as any).argsHash;
  expect(isValidEvent(noHash)).toBe(false);
});

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
  expect(isValidEvent(mkEvent("tool_request", { turn: "t1", tool: "ls", args: {}, requestId: "r1", provenance: "provider_structured", argsHash: "ab".repeat(32) }))).toBe(true);
  expect(isValidEvent(mkEvent("approval_request", { turn: "t1", requestId: "r1", tool: "ls", argsHash: "ab".repeat(32), risk: "low" }))).toBe(true);
  expect(isValidEvent(mkEvent("approval_decision", { requestId: "r1", decision: "allow" }))).toBe(true);
  expect(isValidEvent(mkEvent("tool_result", { turn: "t1", tool: "ls", ok: true, output: "", requestId: "r1", taint: "tool_output" }))).toBe(true);
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
