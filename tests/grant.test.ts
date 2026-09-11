import { test, expect } from "bun:test";
import { Grant, parseGrant } from "../src/grant";

// A grant is a PER-LAUNCH authorization for unattended runs, not a standing
// rule: it names tool CLASSES (read / write / fetch) and argv PREFIXES for
// run_command, and it never reaches critical risk. Its presence means "no
// human is here" -- anything it does not cover is denied, not asked.

test("parse: classes are additive, write implies read, unknown class throws", () => {
  expect(parseGrant("read", []).classes).toEqual(new Set(["read"]));
  expect(parseGrant("write", []).classes).toEqual(new Set(["read", "write"]));
  expect(parseGrant("write,fetch", []).classes).toEqual(new Set(["read", "write", "fetch"]));
  expect(() => parseGrant("shell", [])).toThrow(/unknown grant class/);
  expect(() => parseGrant("", [])).toThrow(/empty grant/);
});

test("read covers read_file/glob/grep at low risk and nothing at medium or above", () => {
  const g = parseGrant("read", []);
  expect(g.covers("read_file", { path: "a.txt" }, "low")).toBe(true);
  expect(g.covers("grep", { pattern: "x" }, "low")).toBe(true);
  expect(g.covers("write_file", { path: "a.txt", content: "" }, "medium")).toBe(false);
  expect(g.covers("read_file", { path: "../etc/passwd" }, "critical")).toBe(false);
});

test("write covers write_file/edit_file at medium, still never critical", () => {
  const g = parseGrant("write", []);
  expect(g.covers("write_file", { path: "a.txt", content: "" }, "medium")).toBe(true);
  expect(g.covers("edit_file", { path: "a.txt" }, "medium")).toBe(true);
  expect(g.covers("edit_file", { path: "/etc/hosts" }, "critical")).toBe(false);
  expect(g.covers("fetch", { url: "https://example.com" }, "medium")).toBe(false); // fetch is its own class
});

test("fetch is its own class and covers only public (medium) urls, not high", () => {
  const g = parseGrant("fetch", []);
  expect(g.covers("fetch", { url: "https://example.com" }, "medium")).toBe(true);
  expect(g.covers("fetch", { url: "http://10.0.0.1/" }, "high")).toBe(false);
  expect(g.covers("read_file", { path: "a" }, "low")).toBe(false);
});

test("run_command is covered ONLY by an argv prefix, matched word-for-word from argv[0]", () => {
  const g = parseGrant("read", ["bun test", "git commit", "bun x tsc --noEmit"]);
  expect(g.covers("run_command", { argv: ["bun", "test"] }, "high")).toBe(true);
  expect(g.covers("run_command", { argv: ["bun", "test", "tests/grant.test.ts"] }, "high")).toBe(true);
  expect(g.covers("run_command", { argv: ["git", "commit", "-m", "x"] }, "high")).toBe(true);
  expect(g.covers("run_command", { argv: ["git", "push"] }, "high")).toBe(false);
  expect(g.covers("run_command", { argv: ["bun"] }, "high")).toBe(false);             // shorter than the prefix
  expect(g.covers("run_command", { argv: ["bun", "testx"] }, "high")).toBe(false);    // word, not substring
  expect(g.covers("run_command", { argv: ["bun", "x", "tsc"] }, "high")).toBe(false); // prefix has 4 words
  expect(g.covers("run_command", { argv: "bun test" }, "high")).toBe(false);          // argv must be an array
  expect(g.covers("run_command", { argv: ["bun", "test"] }, "critical")).toBe(false);
});

test("an empty or whitespace allow-run prefix is refused (it would match every command)", () => {
  expect(() => parseGrant("read", [""])).toThrow(/empty allow-run/);
  expect(() => parseGrant("read", ["   "])).toThrow(/empty allow-run/);
});

test("describe() renders the grant for the card/log, run prefixes quoted", () => {
  const g = parseGrant("write", ["bun test", "git commit"]);
  expect(g.describe()).toBe('grant: read,write; run: "bun test", "git commit"');
  expect(new Grant(new Set(["read"]), []).describe()).toBe("grant: read; run: (none)");
});
