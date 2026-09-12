import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScarCommand } from "../src/commands";
import { SessionStore } from "../src/session";
import { mkEvent } from "../src/events";
import { renderBook } from "../src/book";
import { memoryDir } from "../src/memory";

beforeEach(() => { process.env.RAZIEL_HOME = mkdtempSync(join(tmpdir(), "raziel-scar-cmd-test-")); });

test("/scar <text>: not-command on any other line, handled on bare and argumented /scar", () => {
  const store = new SessionStore("s1");
  const cmd = createScarCommand({ store, write: () => {} });
  expect(cmd("/model")).toBe("not-command");
  expect(cmd("/scarnival")).toBe("not-command"); // prefix-only match must not fire on a longer word
  expect(cmd("/scar")).toBe("handled");
  expect(cmd("/scar something")).toBe("handled");
});

test("/scar with no text prints usage and writes nothing", () => {
  const store = new SessionStore("s1");
  let out = "";
  const cmd = createScarCommand({ store, write: (s) => { out += s; } });
  cmd("/scar   ");
  expect(out).toContain("usage");
  expect(store.replay().length).toBe(0);
});

test("/scar writes a file under memoryDir() and appends a memory_write event with a matching hash", () => {
  const store = new SessionStore("s1");
  let out = "";
  const cmd = createScarCommand({ store, write: (s) => { out += s; } });

  cmd("/scar remember to check the book renders this");

  const events = store.replay();
  expect(events.length).toBe(1);
  const e = events[0] as any;
  expect(e.type).toBe("memory_write");
  expect(e.sessionRef).toBe("s1");
  expect(e.eventRefs).toEqual([]); // no prior turn events in this session
  expect(e.taint).toBeUndefined();

  const path = join(memoryDir(), `${e.scarId}.md`);
  const body = readFileSync(path, "utf8");
  expect(body).toContain("remember to check the book renders this");
  expect(out).toContain(e.scarId);
});

test("/scar scopes provenance to the most recent turn and inherits tool_output taint", () => {
  const store = new SessionStore("s1");
  const u1 = mkEvent("user_message", { text: "first turn" });
  const te1 = mkEvent("turn_end", { turn: "turn1", stop: "end" });
  store.append(u1); store.append(te1);

  const u2 = mkEvent("user_message", { text: "second turn" });
  const tr = mkEvent("tool_result", { turn: "turn2", tool: "read_file", ok: true, output: "data", requestId: "r1", taint: "tool_output" });
  store.append(u2); store.append(tr);

  let out = "";
  const cmd = createScarCommand({ store, write: (s) => { out += s; } });
  cmd("/scar this scar should only reference turn2's events");

  const events = store.replay();
  const write = events[events.length - 1] as any;
  expect(write.type).toBe("memory_write");
  // Only turn2's events (u2, tr) are in scope — turn1's u1/te1 are excluded.
  expect(write.eventRefs.sort()).toEqual([u2.id, tr.id].sort());
  expect(write.taint).toBe("tool_output");
  expect(out).toContain("tainted");
});

test("/scar in a real session produces a file the Book renders (v1.1a acceptance)", () => {
  const store = new SessionStore("s1");
  const cmd = createScarCommand({ store, write: () => {} });
  cmd("/scar a real scar from a real session");

  const rendered = renderBook(store.replay());
  expect(rendered).toContain("scar");
});

test("/scar prefers storeBox.current over the startup store (I1 pattern)", () => {
  const startup = new SessionStore("startup");
  const resumed = new SessionStore("resumed");
  const storeBox = { current: resumed };
  const cmd = createScarCommand({ store: startup, storeBox, write: () => {} });

  cmd("/scar goes to the resumed session");

  expect(startup.replay().length).toBe(0);
  expect(resumed.replay().length).toBe(1);
  expect((resumed.replay()[0] as any).sessionRef).toBe("resumed");
});
