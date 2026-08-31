import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine";
import { SessionStore } from "../src/session";
import { FakeProvider } from "../src/providers/fake";

beforeEach(() => { process.env.RAZIEL_HOME = mkdtempSync(join(tmpdir(), "raziel-test-")); });

async function drain(it: AsyncIterable<{ type: string }>) {
  const out: any[] = []; for await (const e of it) out.push(e); return out;
}

test("a turn: deltas stream, log gets user_message/assistant_message/turn_end", async () => {
  const store = new SessionStore("e1");
  const eng = new Engine({ provider: new FakeProvider([["Hi", " there"]]), store, model: "m" });
  const events = await drain(eng.send("hello"));
  expect(events.filter((e) => e.type === "assistant_delta").length).toBe(2);
  const logged = store.replay().map((e) => e.type);
  expect(logged).toEqual(["user_message", "assistant_message", "turn_end"]);
  const msg = store.replay()[1] as any;
  expect(msg.text).toBe("Hi there");
});

test("context includes prior turns (memory across turns)", async () => {
  const store = new SessionStore("e2");
  const p = new FakeProvider([["one"], ["two"]]);
  const eng = new Engine({ provider: p, store, model: "m" });
  await drain(eng.send("first"));
  await drain(eng.send("second"));
  const secondCall = p.calls[1]!;
  expect(secondCall.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  expect(secondCall[1]!.content).toBe("one");
});

test("abort mid-stream logs partial message and interrupt turn_end", async () => {
  const store = new SessionStore("e3");
  const eng = new Engine({ provider: new FakeProvider([["a", "b", "c"]]), store, model: "m" });
  const ctl = new AbortController();
  for await (const e of eng.send("go", { signal: ctl.signal })) {
    if (e.type === "assistant_delta") ctl.abort();
  }
  const types = store.replay().map((e) => e.type);
  expect(types).toEqual(["user_message", "assistant_message", "turn_end"]);
  expect((store.replay()[2] as any).stop).toBe("interrupt");
});

test("provider throw becomes error event + error turn_end, does not throw", async () => {
  const bad = { name: "bad", async *stream(): AsyncIterable<never> { throw new Error("boom"); } };
  const store = new SessionStore("e4");
  const eng = new Engine({ provider: bad as any, store, model: "m" });
  const events = await drain(eng.send("x"));
  expect(events.some((e) => e.type === "error")).toBe(true);
  expect((store.replay().at(-1) as any).stop).toBe("error");
});
