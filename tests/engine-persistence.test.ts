import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
