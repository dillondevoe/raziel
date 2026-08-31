import { test, expect } from "bun:test";
import { mkEvent } from "../src/events";

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
