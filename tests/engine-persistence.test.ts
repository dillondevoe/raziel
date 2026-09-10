import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine";
import { SessionStore } from "../src/session";
import { FakeProvider } from "../src/providers/fake";
import { Workspace } from "../src/tools/workspace";
import { builtinTools } from "../src/tools/registry";
import { ApprovalManager } from "../src/approvals";
import { Rules } from "../src/rules";
import type { EngineEvent, SessionEvent } from "../src/events";
import type { Provider } from "../src/provider";

async function fixture(failType: SessionEvent["type"], run: (store: SessionStore, root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "raziel-persistence-"));
  const prev = process.env.RAZIEL_HOME;
  process.env.RAZIEL_HOME = root;
  class FailingStore extends SessionStore {
    append(e: SessionEvent) {
      if (e.type === failType) throw new Error(`cannot persist ${failType}`);
      super.append(e);
    }
  }
  try { await run(new FailingStore("failure"), root); }
  finally {
    if (prev === undefined) delete process.env.RAZIEL_HOME;
    else process.env.RAZIEL_HOME = prev;
    rmSync(root, { recursive: true, force: true });
  }
}

async function drain(engine: Engine): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of engine.send("audit")) events.push(event);
  return events;
}

for (const failType of ["assistant_message", "turn_end"] as const) {
  test(`failed ${failType} persistence is visible and never reports success`, async () => {
    await fixture(failType, async (store) => {
      const engine = new Engine({ provider: new FakeProvider([["result"]]), store, model: "test" });
      const events = await drain(engine);
      expect(events).toContainEqual(expect.objectContaining({ type: "error", message: `cannot persist ${failType}` }));
      expect(events.at(-1)).toMatchObject({ type: "turn_end", stop: "error" });
    });
  });
}

for (const failType of ["tool_request", "approval_request", "approval_decision", "tool_result"] as const) {
  test(`failed ${failType} persistence stops tool work and re-streaming`, async () => {
    await fixture(failType, async (store, root) => {
      let calls = 0;
      let executions = 0;
      const provider: Provider = {
        name: "scripted",
        async *stream() {
          calls++;
          if (calls === 1) yield { type: "tool_call", id: "read-1", name: "read_file", args: { path: "note.txt" } };
          else yield { type: "delta", text: "result" };
          yield { type: "done", stopReason: "end" };
        },
      };
      const registry = builtinTools();
      registry.set("read_file", {
        spec: registry.get("read_file")!.spec,
        async run() { executions++; return { ok: true, output: "evidence" }; },
      });
      const rulesPath = join(root, "rules.json");
      const approvals = new ApprovalManager(Rules.load(rulesPath), { ask: async () => "allow" }, rulesPath);
      const engine = new Engine({ provider, store, model: "test", tools: { registry, approvals, ws: new Workspace(root) } });
      const events = await drain(engine);
      expect(events).toContainEqual(expect.objectContaining({ type: "error", message: `cannot persist ${failType}` }));
      expect(events.at(-1)).toMatchObject({ type: "turn_end", stop: "error" });
      expect(calls).toBe(1);
      expect(executions).toBe(failType === "tool_result" ? 1 : 0);
    });
  });
}

// --- ordering arms (review of PR #1): what a store failure must NOT take with it -------------

test("a turn_end append failure still yields the assistant_message that already persisted, and the store gets a turn_end(error)", async () => {
  await fixture("turn_end", async (store) => {
    let armed = true;
    const original = store.append.bind(store);
    // fail exactly the FIRST turn_end (stop:end); let the error-path turn_end through so the
    // Book has something to flush on.
    (store as any).append = (e: SessionEvent) => {
      if (e.type === "turn_end" && armed) { armed = false; throw new Error("cannot persist turn_end"); }
      SessionStore.prototype.append.call(store, e);
    };
    void original;
    const engine = new Engine({ provider: new FakeProvider([["result"]]), store, model: "test" });
    const events = await drain(engine);
    expect(events).toContainEqual(expect.objectContaining({ type: "assistant_message", text: "result" }));
    const replayed = store.replay().map((e) => e.type);
    expect(replayed).toContain("assistant_message");
    expect(replayed.at(-1)).toBe("turn_end");
  });
});

test("a store failure on an error event does not replace the provider's own diagnostic", async () => {
  await fixture("error", async (store, root) => {
    const provider: Provider = {
      name: "scripted",
      async *stream() { throw new Error("PROVIDER_BOOM"); },
    };
    const rulesPath = join(root, "rules.json");
    const approvals = new ApprovalManager(Rules.load(rulesPath), { ask: async () => "allow" }, rulesPath);
    const engine = new Engine({ provider, store, model: "test", tools: { registry: builtinTools(), approvals, ws: new Workspace(root) } });
    const events = await drain(engine);
    expect(events).toContainEqual(expect.objectContaining({ type: "error", message: "PROVIDER_BOOM" }));
    expect(events).not.toContainEqual(expect.objectContaining({ message: "cannot persist error" }));
  });
});

test("an 'always' approval whose decision record cannot be persisted writes NO standing rule", async () => {
  await fixture("approval_decision", async (store, root) => {
    let calls = 0;
    const provider: Provider = {
      name: "scripted",
      async *stream() {
        calls++;
        if (calls === 1) yield { type: "tool_call", id: "read-1", name: "read_file", args: { path: "note.txt" } };
        yield { type: "done", stopReason: "end" };
      },
    };
    const rulesPath = join(root, "rules.json");
    const approvals = new ApprovalManager(Rules.load(rulesPath), { ask: async () => "always" }, rulesPath);
    const engine = new Engine({ provider, store, model: "test", tools: { registry: builtinTools(), approvals, ws: new Workspace(root) } });
    const events = await drain(engine);
    expect(events.at(-1)).toMatchObject({ type: "turn_end", stop: "error" });
    expect(existsSync(rulesPath)).toBe(false);
  });
});

test("a tool_result whose append fails is still yielded (the side effect already happened)", async () => {
  await fixture("tool_result", async (store, root) => {
    let calls = 0;
    const provider: Provider = {
      name: "scripted",
      async *stream() {
        calls++;
        if (calls === 1) yield { type: "tool_call", id: "read-1", name: "read_file", args: { path: "note.txt" } };
        yield { type: "done", stopReason: "end" };
      },
    };
    writeFileSync(join(root, "note.txt"), "evidence");
    const rulesPath = join(root, "rules.json");
    const approvals = new ApprovalManager(Rules.load(rulesPath), { ask: async () => "allow" }, rulesPath);
    const engine = new Engine({ provider, store, model: "test", tools: { registry: builtinTools(), approvals, ws: new Workspace(root) } });
    const events = await drain(engine);
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_result", ok: true }));
    expect(events.at(-1)).toMatchObject({ type: "turn_end", stop: "error" });
  });
});
