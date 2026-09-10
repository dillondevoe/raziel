export type ChatMessage = { role: "user" | "assistant"; content: string };

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
