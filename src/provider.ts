// A tool round is three things on the wire, not one: the model's REQUEST to
// call a tool, the tool's OUTPUT, and the join between them. Before 2026-09-10
// this type could express only the third-person summary of all three -- a user
// message reading "[tool_result read_file] ..." -- and that is why both live
// arms (Claude on PR #2, astra on PR #4) re-requested an identical, already
// answered tool call until the round limit fired. Nothing was replaying the
// model's own tool call back to it, so from the model's side it had never
// called the tool and the sensible move was to call it. The bug was never in a
// provider; it was that the shared vocabulary had no word for "you asked".
export type ToolCall = { id: string; name: string; args: unknown };

/** `ok: false` is a REPORTED failure, not a transport one: a denial, an unknown
 * tool, an argsHash mismatch, a tool that threw. It is content the model must
 * see -- a denied call replayed as absent reads as an unanswered request, which
 * is the same starvation the union above exists to end. */
export type ToolResult = { id: string; name: string; ok: boolean; output: string };

// `content` on an assistant message may be "" -- that is normal, not a defect.
// Assistant prose is accumulated across a whole turn and persisted once at
// turn_end, so a mid-turn round genuinely has no text of its own to replay, and
// inventing some would be a fabricated transcript. The tool call IS the content.
//
// A `tool` message carries one round's results TOGETHER, in the request order of
// the assistant message before it. Batching is not a convenience: the anthropic
// wire format requires every tool_result for a round in a single user message,
// and splitting them is a 400.
export type ChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; results: ToolResult[] };

// RULE FOR ANY PROVIDER ADDED LATER: if your wire format cannot carry a
// `role: "tool"` message, THROW. Do not drop it and do not stringify it into a
// user message -- a dropped tool result replays as a call the model can see
// itself making with no answer, which is precisely the starvation described
// above, and it is invisible. All four providers in this tree map it natively
// (anthropic tool_use/tool_result, openai-compat tool_calls/role:"tool",
// openai-responses function_call/function_call_output, ollama's native
// message.tool_calls), so there is deliberately no shared "unsupported" error
// class here: an exported error nothing throws is a placeholder, and this repo
// does not ship those.

export type ToolSpec = { name: string; description: string; inputSchema: object };

/** Provider-reported counts only. Input excludes separately counted cache reads/writes;
 * output includes reasoning. Missing optional counts are unknown, not measured zero. */
export type TokenUsage = {
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
};

export type StreamChunk =
  | { type: "delta"; text: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  // At most one final usage snapshot per stream() call, never estimates/deltas.
  | { type: "usage"; usage: TokenUsage }
  | { type: "done"; stopReason: "end" | "error" };

export interface Provider {
  readonly name: string;
  stream(opts: {
    model: string;
    system?: string;
    messages: ChatMessage[];
    signal?: AbortSignal;
    sampling?: { temperature?: number; topP?: number };
    contextTokens?: number;
    tools?: ToolSpec[];
  }): AsyncIterable<StreamChunk>;
}
