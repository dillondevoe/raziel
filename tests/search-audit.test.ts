import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grepTool } from "../src/tools/search";
import { Workspace } from "../src/tools/workspace";

async function fixture(run: (ws: Workspace) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "raziel-search-"));
  try { await run(new Workspace(root)); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test("grep searches an explicit directory with file:line evidence", async () => {
  await fixture(async (ws) => {
    mkdirSync(join(ws.root, "src"));
    writeFileSync(join(ws.root, "src", "engine.ts"), "first\naudit-marker\n");
    writeFileSync(join(ws.root, "outside-subtree.txt"), "audit-marker");
    const result = await grepTool.run({ path: "src", pattern: "audit-marker" }, ws);
    expect(result).toEqual({ ok: true, output: "src/engine.ts:2:audit-marker" });
  });
});

test("grep reports a missing explicit path as an error, not a clean no-match", async () => {
  await fixture(async (ws) => {
    const result = await grepTool.run({ path: "missing.txt", pattern: "marker" }, ws);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("ENOENT");
  });
});

test("grep makes the existing 200-file search limit visible", async () => {
  await fixture(async (ws) => {
    for (let i = 0; i < 201; i++) writeFileSync(join(ws.root, `${i}.txt`), "not a match");
    const result = await grepTool.run({ pattern: "absent-marker" }, ws);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("[truncated: searched 200 files; narrow path]");
  });
});

test("grep keeps small searches clean and refuses directory symlink escape", async () => {
  await fixture(async (ws) => {
    writeFileSync(join(ws.root, "a.txt"), "nothing");
    expect(await grepTool.run({ pattern: "marker" }, ws)).toEqual({ ok: true, output: "" });
    await fixture(async (outside) => {
      symlinkSync(outside.root, join(ws.root, "link"));
      const result = await grepTool.run({ path: "link", pattern: "marker" }, ws);
      expect(result.ok).toBe(false);
      expect(result.output).toContain("escapes workspace");
    });
  });
});
