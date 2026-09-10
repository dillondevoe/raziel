import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine";
import { SessionStore } from "../src/session";
import { FakeProvider } from "../src/providers/fake";
import { mkEvent, isValidEvent, type EngineEvent, type SessionEvent } from "../src/events";
import type { Provider } from "../src/provider";
import { renderBook } from "../src/book";
import { Workspace } from "../src/tools/workspace";
import { builtinTools } from "../src/tools/registry";
import { ApprovalManager } from "../src/approvals";
import { Rules } from "../src/rules";
import { MAX_ROUNDS } from "../src/engine_tools";

const measured = { input_tokens: 70, output_tokens: 15, reasoning_tokens: 4, cache_read_tokens: 20, cache_write_tokens: 10 };
const usageEvents = (events: EngineEvent[]) => events.filter((e) => e.type === "usage");

async function fixture(run: (store: SessionStore, root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "raziel-usage-"));
  const previous = process.env.RAZIEL_HOME;
  process.env.RAZIEL_HOME = root;
  try { await run(new SessionStore("usage"), root); }
  finally {
    if (previous === undefined) delete process.env.RAZIEL_HOME; else process.env.RAZIEL_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

async function drain(engine: Engine) {
  const events: EngineEvent[] = [];
  for await (const e of engine.send("measure")) events.push(e);
  return events;
}

function tools(root: string) {
  const rulesPath = join(root, "rules.json");
  return { registry: builtinTools(), ws: new Workspace(root), approvals: new ApprovalManager(Rules.load(rulesPath), { ask: async () => "deny" as const }, rulesPath) };
}

for (const withTools of [false, true]) {
  test(`engine persists reporting fake usage with live attribution (tools=${withTools})`, async () => {
    await fixture(async (store, root) => {
      const provider = new FakeProvider([["reply"], ["next"]], [measured]);
      const engine = new Engine({ provider, store, model: "fixture-model", tools: withTools ? tools(root) : undefined });
      const events = await drain(engine);
      const usage = usageEvents(events);
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({ type: "usage", provider: "fake", model: "fixture-model", ...measured });
      expect(usage[0]!.turn).toBe(events.find((e) => e.type === "turn_end")!.turn);
      expect(usageEvents(store.replay())).toEqual(usage);
      await drain(engine);
      expect(usageEvents(store.replay())).toHaveLength(1);
      expect(provider.calls[1]).toEqual([{ role: "user", content: "measure" }, { role: "assistant", content: "reply" }, { role: "user", content: "measure" }]);
    });
  });

  test(`non-reporting fake emits no usage or placeholder zeros (tools=${withTools})`, async () => {
    await fixture(async (store, root) => {
      const engine = new Engine({ provider: new FakeProvider([["reply"]]), store, model: "fixture", tools: withTools ? tools(root) : undefined });
      expect(usageEvents(await drain(engine))).toEqual([]);
      expect(usageEvents(store.replay())).toEqual([]);
    });
  });

  test(`usage append failure stops the turn before further tool work (tools=${withTools})`, async () => {
    await fixture(async (store, root) => {
      const append = store.append.bind(store);
      store.append = (e: SessionEvent) => {
        if (e.type === "usage") throw new Error("usage disk failure");
        append(e);
      };
      const provider = new FakeProvider([["reply"]], [measured]);
      if (withTools) provider.scriptTool("read_file", { path: "missing.txt" });
      const events = await drain(new Engine({ provider, store, model: "fixture", tools: withTools ? tools(root) : undefined }));
      expect(events).toContainEqual(expect.objectContaining({ type: "error", message: "usage disk failure" }));
      expect(events.at(-1)).toMatchObject({ type: "turn_end", stop: "error" });
      expect(usageEvents(events)).toEqual([]);
      expect(events.some((e) => e.type === "tool_request")).toBe(false);
      expect(provider.calls).toHaveLength(1);
    });
  });
}

test("each provider call in a bounded tool turn has one usage event, not one aggregate per send", async () => {
  await fixture(async (store, root) => {
    const provider = new FakeProvider([], Array.from({ length: MAX_ROUNDS }, () => measured));
    provider.scriptTool("read_file", { path: "missing.txt" });
    const events = await drain(new Engine({ provider, store, model: "fixture", tools: tools(root) }));
    expect(provider.calls).toHaveLength(MAX_ROUNDS);
    const usage = usageEvents(events);
    expect(usage).toHaveLength(MAX_ROUNDS);
    expect(new Set(usage.map((e) => e.id)).size).toBe(MAX_ROUNDS);
    expect(new Set(usage.map((e) => e.turn)).size).toBe(1);
    expect(usageEvents(store.replay())).toEqual(usage);
  });
});

for (const withTools of [false, true]) {
  test(`duplicate usage chunks are not double counted; reported usage survives a later error (tools=${withTools})`, async () => {
    await fixture(async (store, root) => {
      const provider: Provider = { name: "fixture", async *stream() {
        yield { type: "usage", usage: measured };
        yield { type: "usage", usage: measured };
        throw new Error("after measurement");
      } };
      const events = await drain(new Engine({ provider, store, model: "fixture", tools: withTools ? tools(root) : undefined }));
      expect(usageEvents(events)).toHaveLength(1);
      expect(usageEvents(store.replay())).toHaveLength(1);
      expect(events).toContainEqual(expect.objectContaining({ type: "error", message: "after measurement" }));
    });
  });
}

test("reported zero is valid; absent, negative, nonfinite and noninteger counters are invalid on replay", () => {
  const event = mkEvent("usage", { turn: "t", provider: "fixture", model: "m", input_tokens: 0, output_tokens: 0 });
  expect(isValidEvent(event)).toBe(true);
  expect(isValidEvent({ ...event, ...measured })).toBe(true);
  for (const key of ["input_tokens", "output_tokens", "reasoning_tokens", "cache_read_tokens", "cache_write_tokens"]) {
    for (const value of [-1, NaN, Infinity, 1.5, "4", null]) expect(isValidEvent({ ...event, [key]: value })).toBe(false);
  }
  expect(isValidEvent({ ...event, input_tokens: undefined })).toBe(false);
  expect(isValidEvent({ ...event, provider: undefined })).toBe(false);
  expect(isValidEvent({ ...event, model: undefined })).toBe(false);
});

test("Book renders usage independently of turn completion and sanitizes attribution", () => {
  const event = mkEvent("usage", { turn: "t", provider: "fixture\x1b[31m", model: "m\x1b[0m", ...measured });
  const book = renderBook([event]);
  expect(book).toContain("usage fixture/m: input 70, output 15, reasoning 4, cache read 20, cache write 10 tokens");
  expect(book).not.toContain("\x1b");
  const minimal = renderBook([mkEvent("usage", { turn: "t", provider: "fixture", model: "m", input_tokens: 0, output_tokens: 0 })]);
  expect(minimal).toContain("input 0, output 0 tokens");
  expect(minimal).not.toContain("reasoning");
  expect(minimal).not.toContain("cache");
});
