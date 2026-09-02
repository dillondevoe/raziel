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

test("hostile ANSI/OSC bytes in an assistant delta are sanitized before hitting write()", async () => {
  const store = new SessionStore("r-hostile");
  const hostileDelta = "\x1b]0;PWNED\x07visible\x1b[2Jtext";
  const engine = new Engine({ provider: new FakeProvider([[hostileDelta]]), store, model: "m" });
  let out = "";
  await runRepl({ engine, input: lines("hi", "/quit"), write: (s) => { out += s; } });
  expect(out).not.toContain("\x1b");
  expect(out).toContain("visibletext");
});

test("hostile bytes in an error message are sanitized before hitting write()", async () => {
  const store = new SessionStore("r-hostile-err");
  const bad = {
    name: "bad",
    async *stream(): AsyncIterable<never> { throw new Error("boom\x1b]52;c;evil\x07tail"); },
  };
  const engine = new Engine({ provider: bad as any, store, model: "m" });
  let out = "";
  await runRepl({ engine, input: lines("hi", "/quit"), write: (s) => { out += s; } });
  expect(out).not.toContain("\x1b");
  expect(out).toContain("boomtail");
});
