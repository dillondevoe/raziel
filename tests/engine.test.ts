import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine";
import { SessionStore } from "../src/session";
import { FakeProvider } from "../src/providers/fake";
import { getProfile } from "../src/profiles";

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
  expect((store.replay().at(-1) as any).stop).toBe("end");
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

test("abort mid-stream (signal-honoring provider) logs partial message and interrupt turn_end", async () => {
  const store = new SessionStore("e3");
  const provider = new FakeProvider([["a", "b", "c"]]);
  const eng = new Engine({ provider, store, model: "m" });
  const ctl = new AbortController();
  for await (const e of eng.send("go", { signal: ctl.signal })) {
    if (e.type === "assistant_delta") ctl.abort();
  }
  const types = store.replay().map((e) => e.type);
  expect(types).toEqual(["user_message", "assistant_message", "turn_end"]);
  expect((store.replay()[1] as any).text).toBe("a");
  expect((store.replay()[2] as any).stop).toBe("interrupt");
});

test("abort before any delta yields interrupt with no assistant_message (empty-interrupt asymmetry)", async () => {
  const store = new SessionStore("e-zero");
  const provider = new FakeProvider([["a", "b", "c"]]);
  const eng = new Engine({ provider, store, model: "m" });
  const ctl = new AbortController();
  ctl.abort();
  await drain(eng.send("go", { signal: ctl.signal }));
  const types = store.replay().map((e) => e.type);
  expect(types).toEqual(["user_message", "turn_end"]);
  expect((store.replay().at(-1) as any).stop).toBe("interrupt");
});

test("provider throw becomes error event + error turn_end, does not throw", async () => {
  const bad = { name: "bad", async *stream(): AsyncIterable<never> { throw new Error("boom"); } };
  const store = new SessionStore("e4");
  const eng = new Engine({ provider: bad as any, store, model: "m" });
  const events = await drain(eng.send("x"));
  expect(events.some((e) => e.type === "error")).toBe(true);
  expect((store.replay().at(-1) as any).stop).toBe("error");
});

test("store.append failure yields error event, never throws", async () => {
  class ThrowingStore extends SessionStore {
    append() { throw new Error("disk"); }
  }
  const eng = new Engine({ provider: new FakeProvider([["hi"]]), store: new ThrowingStore() as any, model: "m" });
  const events = await drain(eng.send("x"));
  expect(events.some((e) => e.type === "error")).toBe(true);
  const turnEnd = events.find((e) => e.type === "turn_end") as any;
  expect(turnEnd?.stop).toBe("error");
});

test("signal abort after provider signals done is 'end', not 'interrupt'", async () => {
  let ctl: AbortController;
  const provider = {
    name: "test",
    async *stream() {
      yield { type: "delta" as const, text: "a" };
      yield { type: "delta" as const, text: "b" };
      yield { type: "done" as const, stopReason: "end" as const };
      ctl!.abort();
      // provider already signaled done before the consumer's abort lands
    }
  };
  const store = new SessionStore("e-sig");
  const eng = new Engine({ provider, store, model: "m" });
  ctl = new AbortController();
  await drain(eng.send("go", { signal: ctl.signal }));
  const stored = store.replay();
  const turnEnd = stored.find((e) => e.type === "turn_end") as any;
  expect(turnEnd?.stop).toBe("end");
  const msg = stored.find((e) => e.type === "assistant_message") as any;
  expect(msg?.text).toBe("ab");
});

test("provider error does not persist partial assistant_message", async () => {
  const provider = {
    name: "test",
    async *stream() {
      yield { type: "delta" as const, text: "oops" };
      throw new Error("bang");
    }
  };
  const store = new SessionStore("e-err");
  const eng = new Engine({ provider, store, model: "m" });
  const events = await drain(eng.send("x"));
  expect(events.some((e) => e.type === "error")).toBe(true);
  const stored = store.replay();
  const types = stored.map((e) => e.type);
  expect(types).toEqual(["user_message", "error", "turn_end"]);
});

test("done chunk delivered in the same tick as abort still counts as end", async () => {
  const store = new SessionStore("race1");
  // Provider that flips the abort flag and THEN yields done in the same resumption,
  // so the engine's loop sees aborted===true on the very delivery carrying done.
  let ctl!: AbortController;
  const p = {
    name: "race",
    async *stream(): AsyncIterable<{ type: "delta"; text: string } | { type: "done"; stopReason: "end" }> {
      yield { type: "delta", text: "full" };
      ctl.abort();                       // abort visible BEFORE the done chunk is dispatched
      yield { type: "done", stopReason: "end" };
    },
  };
  const eng = new Engine({ provider: p as any, store, model: "m" });
  ctl = new AbortController();
  for await (const _ of eng.send("go", { signal: ctl.signal })) { /* drain */ }
  const end = store.replay().at(-1) as any;
  expect(end.type).toBe("turn_end");
  expect(end.stop).toBe("end");          // completed turn must not be mislabeled interrupt
});

test("engine takes model from a profile and passes sampling through to the provider", async () => {
  const store = new SessionStore("e-profile");
  const provider = new FakeProvider([["hi"]]);
  const eng = new Engine({ provider, store, profile: getProfile("qwen")! });
  await drain(eng.send("go"));
  expect(provider.optsLog[0]?.model).toBe("qwen3.5:9b");
  expect(provider.optsLog[0]?.sampling).toEqual({ temperature: 0.7, topP: 0.8 });
});
