import { describe, test, expect } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../src/tools/workspace";
import { readFileTool, writeFileTool, editFileTool } from "../src/tools/files";
import { globTool } from "../src/tools/search";

function mkws(): Workspace {
  const dir = mkdtempSync(join(tmpdir(), "raziel-ws-"));
  return new Workspace(dir);
}

describe("fix round: globTool containment", () => {
  test("absolute pattern outside root is rejected", async () => {
    const ws = mkws();
    const r = await globTool.run({ pattern: "/etc/*" }, ws);
    expect(r.ok).toBe(false);
  });

  test("traversal pattern is rejected", async () => {
    const ws = mkws();
    const r = await globTool.run({ pattern: "../*" }, ws);
    expect(r.ok).toBe(false);
  });

  test("normal pattern still works", async () => {
    const ws = mkws();
    await writeFileTool.run({ path: "still-works.txt", content: "hi" }, ws);
    const r = await globTool.run({ pattern: "*.txt" }, ws);
    expect(r.ok).toBe(true);
    expect(r.output).toMatch(/still-works\.txt/);
  });
});

describe("fix round: editFileTool rejects empty old", () => {
  test("empty old is rejected, file unchanged", async () => {
    const ws = mkws();
    await writeFileTool.run({ path: "ab.txt", content: "ab" }, ws);
    const r = await editFileTool.run({ path: "ab.txt", old: "", new: "X" }, ws);
    expect(r.ok).toBe(false);
    const after = await readFileTool.run({ path: "ab.txt" }, ws);
    expect(after.output).toBe("ab");
  });
});

describe("fix round: symlink escape (security ruling)", () => {
  test("contain() throws on a symlink inside root pointing outside", () => {
    const outside = mkdtempSync(join(tmpdir(), "raziel-outside-"));
    const ws = mkws();
    symlinkSync(outside, join(ws.root, "link"));
    expect(() => ws.contain("link/f.txt")).toThrow(/path escapes workspace: /);
  });

  test("readFileTool / writeFileTool via a symlink escape fail with 'escapes'", async () => {
    const outside = mkdtempSync(join(tmpdir(), "raziel-outside-"));
    writeFileSync(join(outside, "secret.txt"), "shh");
    const ws = mkws();
    symlinkSync(outside, join(ws.root, "link"));

    const r = await readFileTool.run({ path: "link/secret.txt" }, ws);
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/escapes/);

    const w = await writeFileTool.run({ path: "link/new.txt", content: "x" }, ws);
    expect(w.ok).toBe(false);
    expect(w.output).toMatch(/escapes/);
  });

  test("a normal nested non-existent path still contains fine", () => {
    const ws = mkws();
    const resolved = ws.contain("newdir/f.txt");
    expect(resolved).toBe(join(ws.root, "newdir", "f.txt"));
  });

  test("macOS /tmp-is-a-symlink case does not false-positive on plain contains", () => {
    const ws = mkws();
    // ws.root itself is under a possibly-symlinked tmpdir (e.g. /tmp -> /private/tmp
    // on macOS). The constructor must realpath root so ordinary contains still pass.
    expect(ws.contain("plain.txt")).toBe(join(ws.root, "plain.txt"));
    expect(ws.contain(".")).toBe(ws.root);
  });
});

describe("fix round (Critical, C1): dangling-symlink write escape", () => {
  test("contain() throws on a dangling symlink (target doesn't exist, outside root)", () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "raziel-outside-"));
    const ws = mkws();
    symlinkSync(join(outsideDir, "created.txt"), join(ws.root, "link"));

    expect(() => ws.contain("link")).toThrow(/path escapes workspace/);
  });

  test("writeFileTool via a dangling symlink returns ok:false and creates NO file outside", async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "raziel-outside-"));
    const target = join(outsideDir, "created.txt");
    const ws = mkws();
    symlinkSync(target, join(ws.root, "link"));

    const w = await writeFileTool.run({ path: "link", content: "pwned" }, ws);

    expect(w.ok).toBe(false);
    expect(existsSync(target)).toBe(false);
  });

  test("a dangling symlink CHAIN (link -> link2 -> outside, target missing) is also refused", () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "raziel-outside-"));
    const ws = mkws();
    const link2 = join(ws.root, "link2");
    symlinkSync(join(outsideDir, "nope.txt"), link2);
    symlinkSync(link2, join(ws.root, "link"));

    expect(() => ws.contain("link")).toThrow(/path escapes workspace/);
  });

  test("a plain non-existent path (no symlink anywhere in it) still contains fine", () => {
    const ws = mkws();
    expect(ws.contain("newdir/f.txt")).toBe(join(ws.root, "newdir", "f.txt"));
  });
});
