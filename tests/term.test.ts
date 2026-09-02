import { test, expect } from "bun:test";
import { sanitizeForTerminal } from "../src/term";

test("strips OSC-0 title-set sequence (BEL-terminated)", () => {
  const hostile = "before\x1b]0;PWNED-TITLE\x07after";
  expect(sanitizeForTerminal(hostile)).toBe("beforeafter");
});

test("strips OSC-52 clipboard-write sequence (ST-terminated)", () => {
  const hostile = "before\x1b]52;c;aGVsbG8=\x1b\\after";
  expect(sanitizeForTerminal(hostile)).toBe("beforeafter");
});

test("strips OSC sequence terminated by BEL when payload contains ; and base64", () => {
  const hostile = "x\x1b]52;c;dGhpcyBpcyBhIHRlc3Q=\x07y";
  expect(sanitizeForTerminal(hostile)).toBe("xy");
});

test("strips CSI clear-screen sequence", () => {
  const hostile = "before\x1b[2Jafter";
  expect(sanitizeForTerminal(hostile)).toBe("beforeafter");
});

test("strips SGR conceal sequence", () => {
  const hostile = "visible\x1b[8mhidden\x1b[0mtext";
  expect(sanitizeForTerminal(hostile)).toBe("visiblehiddentext");
});

test("strips SS3 single-char escape sequences", () => {
  const hostile = "before\x1bOPafter"; // SS3 + 'P' (F1 key sequence shape)
  expect(sanitizeForTerminal(hostile)).toBe("beforeafter");
});

test("strips bare ESC not part of a recognized sequence", () => {
  const hostile = "before\x1bafter";
  expect(sanitizeForTerminal(hostile)).toBe("beforeafter");
});

test("strips C0 control chars except \\n and \\t", () => {
  const hostile = "a\x00b\x01c\x07d\rline2";
  expect(sanitizeForTerminal(hostile)).toBe("abcdline2");
});

test("preserves newline and tab", () => {
  const s = "line1\n\tindented line2";
  expect(sanitizeForTerminal(s)).toBe(s);
});

test("plain string with emoji and newline survives unchanged", () => {
  const s = "hello 🎉 world\nsecond line — em dash, café";
  expect(sanitizeForTerminal(s)).toBe(s);
});

test("strips DCS sequence", () => {
  const hostile = "before\x1bPq#0;2;0;0;0#1;2;100;100;100\x1b\\after";
  expect(sanitizeForTerminal(hostile)).toBe("beforeafter");
});
