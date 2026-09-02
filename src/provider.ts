export type ChatMessage = { role: "user" | "assistant"; content: string };

export type ToolSpec = { name: string; description: string; inputSchema: object };

export type StreamChunk =
  | { type: "delta"; text: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }
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
