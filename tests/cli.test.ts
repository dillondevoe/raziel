import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRepl } from "../src/cli";
import { Engine } from "../src/engine";
import { SessionStore } from "../src/session";
import { FakeProvider } from "../src/providers/fake";

beforeEach(() => { process.env.RAZIEL_HOME = mkdtempSync(join(tmpdir(), "raziel-test-")); });

async function* lines(...ls: string[]) { for (const l of ls) yield l; }

test("repl streams reply text and stops at /quit", async () => {
  const store = new SessionStore("r1");
  const engine = new Engine({ provider: new FakeProvider([["he", "y"]]), store, model: "m" });
  let out = "";
  await runRepl({ engine, input: lines("hi", "/quit"), write: (s) => { out += s; } });
  expect(out).toContain("hey");
  expect(store.replay().some((e) => e.type === "assistant_message")).toBe(true);
});
