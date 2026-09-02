import { mkEvent, type EngineEvent, type SessionEvent } from "./events";
import type { ChatMessage, Provider } from "./provider";
import type { ApprovalManager } from "./approvals";
import type { BuiltinTool } from "./tools/files";
import { toolSpecs } from "./tools/registry";
import type { Workspace } from "./tools/workspace";
import { riskClassFor } from "./risk";
import { argsHash } from "./tools/types";
import { sanitizeForTerminal } from "./term";

// R10 bound: max tool rounds per turn before the loop force-ends rather than
// re-streaming forever against a provider that keeps calling tools.
const MAX_ROUNDS = 8;

export type ToolDeps = {
  registry: Map<string, BuiltinTool>;
  ws: Workspace;
  approvals: ApprovalManager;
};

type ToolCall = { id: string; name: string; args: unknown };
type Stop = "end" | "interrupt" | "error";

export type RunToolTurnOpts = {
  provider: Provider;
  model: string;
  system?: string;
  sampling?: { temperature?: number; topP?: number };
  contextTokens?: number;
  turn: string;
  signal?: AbortSignal;
  tools: ToolDeps;
  getContext(): ChatMessage[];
  tryAppend(e: SessionEvent): void;
  onDelta(text: string): void;
  finish(stop: Stop): EngineEvent[];
};

/** Runs the tool call through request → risk → approval → (recheck) → execute,
 * yielding every event on the way. The recomputed argsHash (R10) guards
 * against args mutated between the approval decision and execution — it
 * must equal the hash the decision was made against, or the call is refused
 * without running. */
async function* handleToolCall(
  call: ToolCall,
  turn: string,
  tools: ToolDeps,
  tryAppend: (e: SessionEvent) => void,
): AsyncGenerator<EngineEvent> {
  const hash = argsHash(call.name, call.args);
  const req = mkEvent("tool_request", {
    turn, tool: call.name, args: call.args, requestId: call.id,
    provenance: "provider_structured", argsHash: hash,
  });
  tryAppend(req);
  yield req;

  const risk = riskClassFor(call.name, call.args, tools.ws);
  const areq = mkEvent("approval_request", { turn, requestId: call.id, tool: call.name, argsHash: hash, risk });
  tryAppend(areq);
  yield areq;

  const { decision, argsHash: decidedHash } = await tools.approvals.decide(call.name, call.args, risk, tools.ws);
  const adec = mkEvent("approval_decision", { requestId: call.id, decision });
  tryAppend(adec);
  yield adec;

  const result = await execute(call, decision, decidedHash, tools);
  const tres = mkEvent("tool_result", {
    turn, tool: call.name, ok: result.ok, output: sanitizeForTerminal(result.output),
    requestId: call.id, taint: "tool_output",
  });
  tryAppend(tres);
  yield tres;
}

async function execute(
  call: ToolCall,
  decision: "allow" | "deny",
  decidedHash: string,
  tools: ToolDeps,
): Promise<{ ok: boolean; output: string }> {
  if (decision === "deny") return { ok: false, output: "denied by user" };

  // R10: recompute from the args about to execute — must match what the
  // decision was actually made against.
  if (argsHash(call.name, call.args) !== decidedHash) {
    return { ok: false, output: "argsHash mismatch — refusing" };
  }

  const tool = tools.registry.get(call.name);
  if (!tool) return { ok: false, output: "unknown tool" };

  try {
    return await tool.run(call.args, tools.ws);
  } catch (e) {
    return { ok: false, output: e instanceof Error ? e.message : String(e) };
  }
}

/** One provider.stream() round: yields assistant_delta events (via onDelta
 * for accumulation) and collects any tool_call chunks. Mirrors the M1a
 * single-stream loop in engine.ts's send(), plus tool_call collection. */
async function* streamRound(
  provider: Provider,
  model: string,
  system: string | undefined,
  sampling: { temperature?: number; topP?: number } | undefined,
  contextTokens: number | undefined,
  messages: ChatMessage[],
  toolSpecsArr: ReturnType<typeof toolSpecs>,
  signal: AbortSignal | undefined,
  turn: string,
  onDelta: (text: string) => void,
): AsyncGenerator<EngineEvent, { toolCalls: ToolCall[]; stop: Stop; errMessage?: string }> {
  const toolCalls: ToolCall[] = [];
  let interrupted = false;
  let sawDone = false;

  try {
    for await (const chunk of provider.stream({ model, system, messages, signal, sampling, contextTokens, tools: toolSpecsArr })) {
      if (chunk.type === "done") { sawDone = true; continue; }
      if (signal?.aborted) { interrupted = true; break; }
      if (chunk.type === "delta") {
        onDelta(chunk.text);
        yield { type: "assistant_delta", turn, text: chunk.text };
      } else if (chunk.type === "tool_call") {
        toolCalls.push({ id: chunk.id, name: chunk.name, args: chunk.args });
      }
    }
  } catch (err) {
    return { toolCalls, stop: "error", errMessage: err instanceof Error ? err.message : String(err) };
  }

  const stop: Stop = interrupted || (signal?.aborted && !sawDone) ? "interrupt" : "end";
  return { toolCalls, stop };
}

/**
 * The bounded tool loop (Task 6): stream → (tool_request → approval_request
 * → approval_decision → tool_result)* → re-stream, up to MAX_ROUNDS. Engine
 * owns `acc`/`finish` (shared with the no-tools path) and hands them in via
 * onDelta/finish so persisted assistant_message semantics stay identical.
 */
export async function* runToolTurn(opts: RunToolTurnOpts): AsyncGenerator<EngineEvent> {
  const { provider, model, system, sampling, contextTokens, turn, signal, tools, getContext, tryAppend, onDelta, finish } = opts;
  const specs = toolSpecs(tools.registry);

  let stop: Stop = "end";

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (signal?.aborted) { stop = "interrupt"; break; }

    const roundResult = yield* streamRound(
      provider, model, system, sampling, contextTokens, getContext(), specs, signal, turn, onDelta,
    );

    if (roundResult.stop === "error") {
      const e = mkEvent("error", { turn, message: roundResult.errMessage ?? "unknown error" });
      tryAppend(e);
      yield e;
      stop = "error";
      break;
    }

    if (roundResult.stop === "interrupt") { stop = "interrupt"; break; }

    if (roundResult.toolCalls.length === 0) { stop = "end"; break; }

    for (const call of roundResult.toolCalls) {
      if (signal?.aborted) { stop = "interrupt"; break; }
      yield* handleToolCall(call, turn, tools, tryAppend);
    }
    if (stop === "interrupt") break;

    if (round === MAX_ROUNDS - 1) {
      const e = mkEvent("error", { turn, message: "tool round limit" });
      tryAppend(e);
      yield e;
      stop = "end";
      break;
    }
  }

  yield* finish(stop);
}
