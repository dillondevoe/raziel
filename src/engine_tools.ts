import { mkEvent, type EngineEvent, type SessionEvent } from "./events";
import type { ChatMessage, Provider } from "./provider";
import { toolSpecs } from "./tools/registry";
import { handleToolCall, type ToolCall, type ToolDeps } from "./engine_tool_call";

export type { ToolDeps } from "./engine_tool_call";

// R10 bound: max tool rounds per turn before the loop force-ends rather than
// re-streaming forever against a provider that keeps calling tools. Exported
// (M1c Task 5, requirement B) so src/tui/status.ts's "tool round N/MAX_ROUNDS"
// line reads the SAME constant instead of carrying its own hardcoded "8" —
// a duplicated literal that would silently drift if this one ever changed.
export const MAX_ROUNDS = 8;

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
      const { aborted } = yield* handleToolCall(call, turn, tools, tryAppend, signal);
      if (aborted) { stop = "interrupt"; break; }
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
