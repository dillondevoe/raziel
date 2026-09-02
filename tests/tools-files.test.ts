import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { Workspace } from "../src/tools/workspace";
import { readFileTool, writeFileTool, editFileTool } from "../src/tools/files";
import { grepTool, globTool } from "../src/tools/search";

function mkws(): Workspace {
  const dir = mkdtempSync(join(tmpdir(), "raziel-ws-"));
  return new Workspace(dir);
}

describe("Workspace.contain", () => {
  test("rejects parent traversal", () => {
    const ws = mkws();
    expect(() => ws.contain("../x")).toThrow(/path escapes workspace: /);
  });

  test("rejects absolute path outside root", () => {
    const ws = mkws();
    expect(() => ws.contain("/etc/passwd")).toThrow(/path escapes workspace: /);
  });

  test("rejects nested traversal", () => {
    const ws = mkws();
    expect(() => ws.contain("a/../../x")).toThrow(/path escapes workspace: /);
  });

  test("allows nested path within root", () => {
    const ws = mkws();
    const resolved = ws.contain("sub/f.txt");
    expect(resolved).toBe(join(ws.root, "sub", "f.txt"));
  });

  test("allows root itself", () => {
    const ws = mkws();
    expect(ws.contain(".")).toBe(ws.root);
  });

  test("prefix-boundary: sibling dir sharing name prefix is not contained", () => {
    const base = mkdtempSync(join(tmpdir(), "raziel-pb-"));
    const wsDir = join(base, "ws");
    const siblingDir = join(base, "wsx");
    require("node:fs").mkdirSync(wsDir);
    require("node:fs").mkdirSync(siblingDir);
    writeFileSync(join(siblingDir, "f"), "data");
    const ws = new Workspace(wsDir);
    // Attempt to reach /base/wsx/f via a relative path that resolves outside root.
    expect(() => ws.contain(join("..", "wsx", "f"))).toThrow(/path escapes workspace: /);
    // Also verify direct absolute path to sibling is rejected.
    expect(() => ws.contain(siblingDir + sep + "f")).toThrow(/path escapes workspace: /);
  });
});

describe("readFileTool / writeFileTool / editFileTool roundtrip", () => {
  test("write then read roundtrip", async () => {
    const ws = mkws();
    const w = await writeFileTool.run({ path: "hello.txt", content: "hi there" }, ws);
    expect(w.ok).toBe(true);
    const r = await readFileTool.run({ path: "hello.txt" }, ws);
    expect(r.ok).toBe(true);
    expect(r.output).toBe("hi there");
  });

  test("write refuses to overwrite existing file without overwrite:true", async () => {
    const ws = mkws();
    await writeFileTool.run({ path: "a.txt", content: "one" }, ws);
    const second = await writeFileTool.run({ path: "a.txt", content: "two" }, ws);
    expect(second.ok).toBe(false);
    const third = await writeFileTool.run({ path: "a.txt", content: "two", overwrite: true }, ws);
    expect(third.ok).toBe(true);
    const r = await readFileTool.run({ path: "a.txt" }, ws);
    expect(r.output).toBe("two");
  });

  test("edit requires exactly one match", async () => {
    const ws = mkws();
    await writeFileTool.run({ path: "e.txt", content: "foo bar baz" }, ws);
    const zero = await editFileTool.run({ path: "e.txt", old: "nope", new: "x" }, ws);
    expect(zero.ok).toBe(false);
    expect(zero.output).toMatch(/0/);

    await writeFileTool.run({ path: "e2.txt", content: "dup dup" }, ws);
    const two = await editFileTool.run({ path: "e2.txt", old: "dup", new: "x" }, ws);
    expect(two.ok).toBe(false);
    expect(two.output).toMatch(/2/);

    const one = await editFileTool.run({ path: "e.txt", old: "bar", new: "qux" }, ws);
    expect(one.ok).toBe(true);
    const r = await readFileTool.run({ path: "e.txt" }, ws);
    expect(r.output).toBe("foo qux baz");
  });

  test("read output is capped at 64000 chars with truncation marker", async () => {
    const ws = mkws();
    const big = "x".repeat(70_000);
    await writeFileTool.run({ path: "big.txt", content: big }, ws);
    const r = await readFileTool.run({ path: "big.txt" }, ws);
    expect(r.ok).toBe(true);
    expect(r.output.length).toBeLessThanOrEqual(64_020);
    expect(r.output.endsWith("…[truncated]")).toBe(true);
  });

  test("path outside root fails for read/write/edit", async () => {
    const ws = mkws();
    const r = await readFileTool.run({ path: "../outside.txt" }, ws);
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/escapes/);

    const w = await writeFileTool.run({ path: "../outside.txt", content: "x" }, ws);
    expect(w.ok).toBe(false);
    expect(w.output).toMatch(/escapes/);

    const e = await editFileTool.run({ path: "../outside.txt", old: "a", new: "b" }, ws);
    expect(e.ok).toBe(false);
    expect(e.output).toMatch(/escapes/);
  });
});

describe("grepTool", () => {
  test("invalid regex returns ok:false, does not throw", async () => {
    const ws = mkws();
    const r = await grepTool.run({ pattern: "(" }, ws);
    expect(r.ok).toBe(false);
  });

  test("finds matches in a contained file", async () => {
    const ws = mkws();
    await writeFileTool.run({ path: "grep-me.txt", content: "alpha\nbeta\ngamma\n" }, ws);
    const r = await grepTool.run({ pattern: "beta", path: "grep-me.txt" }, ws);
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/beta/);
  });

  test("path outside root fails", async () => {
    const ws = mkws();
    const r = await grepTool.run({ pattern: "x", path: "../outside.txt" }, ws);
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/escapes/);
  });
});

describe("globTool", () => {
  test("finds the file it made", async () => {
    const ws = mkws();
    await writeFileTool.run({ path: "found-me.md", content: "hi" }, ws);
    const r = await globTool.run({ pattern: "*.md" }, ws);
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/found-me\.md/);
  });
});

describe("tool specs", () => {
  test("every builtin exposes a spec with name/description/inputSchema", () => {
    for (const t of [readFileTool, writeFileTool, editFileTool, grepTool, globTool]) {
      expect(typeof t.spec.name).toBe("string");
      expect(typeof t.spec.description).toBe("string");
      expect(typeof t.spec.inputSchema).toBe("object");
    }
  });
});
