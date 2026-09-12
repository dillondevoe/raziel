import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { writeScar, memoryDir, newScarId } from "../src/memory";

beforeEach(() => { process.env.RAZIEL_HOME = mkdtempSync(join(tmpdir(), "raziel-mem-test-")); });

test("writeScar writes a markdown file with a provenance header and the text body", () => {
  const w = writeScar("always confirm before rm -rf", "sess1", ["e1", "e2"], "tool_output", "fixed-id");
  expect(w.scarId).toBe("fixed-id");
  expect(w.path).toBe(join(memoryDir(), "fixed-id.md"));
  const body = readFileSync(w.path, "utf8");
  expect(body).toContain("scarId: fixed-id");
  expect(body).toContain("sessionRef: sess1");
  expect(body).toContain('eventRefs: ["e1","e2"]');
  expect(body).toContain("taint: tool_output");
  expect(body).toContain("always confirm before rm -rf");
});

test("writeScar with no taint writes 'taint: none', not the literal string 'undefined'", () => {
  const w = writeScar("a plain scar", "sess1", [], undefined, "no-taint-id");
  const body = readFileSync(w.path, "utf8");
  expect(body).toContain("taint: none");
  expect(body).not.toContain("undefined");
});

test("writeScar's returned hash matches a recomputation of the written file's content", () => {
  const w = writeScar("hash me", "sess1", ["e1"], undefined, "hash-id");
  const body = readFileSync(w.path, "utf8");
  expect(w.hash).toBe(createHash("sha256").update(body).digest("hex"));
});

test("newScarId produces unique, filesystem-safe ids", () => {
  const a = newScarId();
  const b = newScarId();
  expect(a).not.toBe(b);
  expect(a).toMatch(/^[A-Za-z0-9._-]+$/);
});

test("a scar id that would escape memoryDir() throws instead of writing outside it", () => {
  expect(() => writeScar("x", "sess1", [], undefined, "../../escape-probe")).toThrow();
  expect(() => writeScar("x", "sess1", [], undefined, "a/b")).toThrow();
});
