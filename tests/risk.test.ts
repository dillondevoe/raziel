import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../src/tools/workspace";
import { riskClassFor } from "../src/risk";

function mkws(): Workspace {
  const dir = mkdtempSync(join(tmpdir(), "raziel-risk-ws-"));
  return new Workspace(dir);
}

describe("riskClassFor", () => {
  test("read_file with a contained path is low", () => {
    const ws = mkws();
    expect(riskClassFor("read_file", { path: "a.txt" }, ws)).toBe("low");
  });

  test("grep with a contained path is low", () => {
    const ws = mkws();
    expect(riskClassFor("grep", { pattern: "foo", path: "a.txt" }, ws)).toBe("low");
  });

  test("grep with no path (whole workspace) is low", () => {
    const ws = mkws();
    expect(riskClassFor("grep", { pattern: "foo" }, ws)).toBe("low");
  });

  test("glob with a contained pattern is low", () => {
    const ws = mkws();
    expect(riskClassFor("glob", { pattern: "*.ts" }, ws)).toBe("low");
  });

  test("a path that escapes the workspace (contain throws) is critical", () => {
    const ws = mkws();
    expect(riskClassFor("read_file", { path: "../evil.txt" }, ws)).toBe("critical");
    expect(riskClassFor("grep", { pattern: "x", path: "../evil.txt" }, ws)).toBe("critical");
    expect(riskClassFor("glob", { pattern: "../*" }, ws)).toBe("critical");
  });

  test("write_file with a contained path is medium", () => {
    const ws = mkws();
    expect(riskClassFor("write_file", { path: "a.txt", content: "hi" }, ws)).toBe("medium");
  });

  test("edit_file with a contained path is medium", () => {
    const ws = mkws();
    expect(riskClassFor("edit_file", { path: "a.txt", old: "a", new: "b" }, ws)).toBe("medium");
  });

  test("write_file escaping the workspace is critical", () => {
    const ws = mkws();
    expect(riskClassFor("write_file", { path: "../evil.txt", content: "x" }, ws)).toBe("critical");
  });

  test("fetch to a public url is medium", () => {
    const ws = mkws();
    expect(riskClassFor("fetch", { url: "https://example.com" }, ws)).toBe("medium");
  });

  test("fetch to a private url is high", () => {
    const ws = mkws();
    expect(riskClassFor("fetch", { url: "http://127.0.0.1:8080/x" }, ws)).toBe("high");
  });

  test("fetch to an invalid url is high", () => {
    const ws = mkws();
    expect(riskClassFor("fetch", { url: "not a url" }, ws)).toBe("high");
  });

  test("SSRF gate: loopback fetch is high", () => {
    const ws = mkws();
    expect(riskClassFor("fetch", { url: "http://127.0.0.1:8080/x" }, ws)).toBe("high");
  });

  test("SSRF gate: cloud metadata fetch is high", () => {
    const ws = mkws();
    expect(riskClassFor("fetch", { url: "http://169.254.169.254/latest" }, ws)).toBe("high");
  });

  test("run_command is always high", () => {
    const ws = mkws();
    expect(riskClassFor("run_command", { argv: ["ls"] }, ws)).toBe("high");
    expect(riskClassFor("run_command", { argv: ["rm", "-rf", "/"] }, ws)).toBe("high");
  });

  test("unknown tool name is critical", () => {
    const ws = mkws();
    expect(riskClassFor("delete_universe", { anything: true }, ws)).toBe("critical");
  });

  test("malformed (non-object) args are critical, fail closed", () => {
    const ws = mkws();
    expect(riskClassFor("read_file", "not an object", ws)).toBe("critical");
    expect(riskClassFor("read_file", null, ws)).toBe("critical");
    expect(riskClassFor("read_file", 42, ws)).toBe("critical");
    expect(riskClassFor("read_file", ["path"], ws)).toBe("critical");
  });

  test("missing required path arg is critical, fail closed", () => {
    const ws = mkws();
    expect(riskClassFor("read_file", {}, ws)).toBe("critical");
    expect(riskClassFor("write_file", { content: "hi" }, ws)).toBe("critical");
  });
});
