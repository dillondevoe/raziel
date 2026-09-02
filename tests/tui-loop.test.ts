import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container } from "@earendil-works/pi-tui";
import { Engine } from "../src/engine";
import { SessionStore } from "../src/session";
import { FakeProvider } from "../src/providers/fake";
import { Workspace } from "../src/tools/workspace";
import { builtinTools } from "../src/tools/registry";
import { Rules } from "../src/rules";
import { ApprovalManager } from "../src/approvals";
import { Transcript } from "../src/tui/transcript";
import { Status } from "../src/tui/status";
import { runTuiMainLoop } from "../src/tui/loop";
import type { ChatMessage, Provider, StreamChunk } from "../src/provider";

beforeEach(() => { process.env.RAZIEL_HOME = mkdtempSync(join(tmpdir(), "raziel-tui-loop-")); });

async function* lines(...ls: string[]) { for (const l of ls) yield l; }

/** Same scripted-per-round provider cli.test.ts uses for exact tool-round
 * control — round i yields that round's deltas/tool_calls. */
class ScriptedToolProvider implements Provider {
  readonly name = "scripted";
  private i = 0;
  constructor(private rounds: { delta?: string[]; toolCalls?: { name: string; args: unknown }[] }[]) {}

  async *stream(opts: {
    model: string; system?: string; messages: ChatMessage[]; signal?: AbortSignal;
    sampling?: unknown; contextTokens?: number; tools?: unknown;
  }): AsyncIterable<StreamChunk> {
    const round = this.rounds[Math.min(this.i, this.rounds.length - 1)] ?? {};
    this.i++;
    for (const text of round.delta ?? []) {
      if (opts.signal?.aborted) return;
      yield { type: "delta", text };
    }
    for (const tc of round.toolCalls ?? []) {
      if (opts.signal?.aborted) return;
      yield { type: "tool_call", id: crypto.randomUUID(), name: tc.name, args: tc.args };
    }
    if (!opts.signal?.aborted) yield { type: "done", stopReason: "end" };
  }
}

function mkWorkspaceWithFile(name: string, content: string): Workspace {
  const dir = mkdtempSync(join(tmpdir(), "raziel-tui-loop-ws-"));
  require("node:fs").writeFileSync(join(dir, name), content);
  return new Workspace(dir);
}

test("a plain scripted turn streams user line + assistant deltas into the transcript in order", async () => {
  const store = new SessionStore("loop-1");
  const engine = new Engine({ provider: new FakeProvider([["foo ", "bar ", "baz"]]), store, model: "m" });
  const engineBox = { current: engine };
  const parent = new Container();
  const transcript = new Transcript(parent);
  const status = new Status(parent);
  const signalRef = { current: null as AbortController | null };

  await runTuiMainLoop({ engineBox, input: lines("hello", "/quit"), transcript, status, signalRef });

  const frame = parent.render(80).join("\n");
  const userIdx = frame.indexOf("hello");
  const assistantIdx = frame.indexOf("foo bar baz");
  expect(userIdx).toBeGreaterThanOrEqual(0);
  expect(assistantIdx).toBeGreaterThan(userIdx);
});

test("status goes streaming -> idle across a turn, and signalRef is cleared afterward", async () => {
  const store = new SessionStore("loop-2");
  const engine = new Engine({ provider: new FakeProvider([["hi"]]), store, model: "m" });
  const engineBox = { current: engine };
  const parent = new Container();
  const transcript = new Transcript(parent);
  const status = new Status(parent);
  const signalRef = { current: null as AbortController | null };
  let sawStreaming = false;
  const seenSignals: (AbortController | null)[] = [];

  // Wrap send() to observe mid-turn state.
  const realSend = engine.send.bind(engine);
  (engine as any).send = async function* (text: string, o?: any) {
    for await (const e of realSend(text, o)) {
      seenSignals.push(signalRef.current);
      yield e;
    }
  };

  await runTuiMainLoop({ engineBox, input: lines("hi", "/quit"), transcript, status, signalRef });

  expect(seenSignals.every((s) => s !== null)).toBe(true); // signal set for the whole turn
  expect(signalRef.current).toBe(null); // cleared after
  const frame = parent.render(80).join("\n");
  expect(frame).toContain("idle");
});

test("onCommand: a handled line never reaches engine.send", async () => {
  let sendCalls = 0;
  const fakeEngine = { send: async function* () { sendCalls++; } } as unknown as Engine;
  const engineBox = { current: fakeEngine };
  const parent = new Container();
  const transcript = new Transcript(parent);
  const status = new Status(parent);
  const signalRef = { current: null as AbortController | null };
  const onCommand = (line: string): "handled" | "not-command" => (line.startsWith("/model") ? "handled" : "not-command");

  await runTuiMainLoop({ engineBox, input: lines("/model qwen", "/quit"), transcript, status, signalRef, onCommand });

  expect(sendCalls).toBe(0);
});

test("scripted tool_call round: approval_request renders a toolCard with risk, tool_result renders the outcome, final delta streams after", async () => {
  const ws = mkWorkspaceWithFile("hello.txt", "hello world");
  const registry = builtinTools();
  const rulesPath = join(require("node:os").tmpdir(), "raziel-tui-loop-rules.json");
  const rules = Rules.load(rulesPath);
  const approvals = new ApprovalManager(rules, { ask: async () => "allow" }, rulesPath);
  const store = new SessionStore("loop-3");
  const provider = new ScriptedToolProvider([
    { toolCalls: [{ name: "read_file", args: { path: "hello.txt" } }] },
    { delta: ["done reading"] },
  ]);
  const engine = new Engine({ provider, store, model: "m", tools: { registry, ws, approvals } });
  const engineBox = { current: engine };
  const parent = new Container();
  const transcript = new Transcript(parent);
  const status = new Status(parent);
  const signalRef = { current: null as AbortController | null };

  await runTuiMainLoop({ engineBox, input: lines("read the file", "/quit"), transcript, status, signalRef });

  const frame = parent.render(80).join("\n");
  expect(frame).toContain("read_file");
  expect(frame).toContain("low"); // risk shown on the request card
  expect(frame).toContain("✓"); // ok result mark
  expect(frame).toContain("hello world"); // tool_result output preview
  expect(frame).toContain("done reading");
});

test("an interrupted turn renders the interrupted marker via Transcript.interruptMark", async () => {
  const store = new SessionStore("loop-4");
  // Provider that never completes on its own — the AbortSignal is what ends it.
  const hangingProvider: Provider = {
    name: "hanging",
    async *stream(opts) {
      await new Promise<void>((resolve) => {
        opts.signal?.addEventListener("abort", () => resolve());
      });
    },
  };
  const engine = new Engine({ provider: hangingProvider, store, model: "m" });
  const engineBox = { current: engine };
  const parent = new Container();
  const transcript = new Transcript(parent);
  const status = new Status(parent);
  const signalRef = { current: null as AbortController | null };

  const loopPromise = runTuiMainLoop({ engineBox, input: lines("hi", "/quit"), transcript, status, signalRef });
  // Give the loop a tick to enter engine.send() and set signalRef, then abort.
  await new Promise((r) => setTimeout(r, 5));
  signalRef.current?.abort();
  await loopPromise;

  const frame = parent.render(80).join("\n");
  expect(frame).toContain("interrupted");
});
