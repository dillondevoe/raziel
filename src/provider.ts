export type ChatMessage = { role: "user" | "assistant"; content: string };

export type StreamChunk =
  | { type: "delta"; text: string }
  | { type: "done"; stopReason: "end" | "error" };

export interface Provider {
  readonly name: string;
  stream(opts: {
    model: string;
    system?: string;
    messages: ChatMessage[];
    signal?: AbortSignal;
    sampling?: { temperature?: number; topP?: number };
  }): AsyncIterable<StreamChunk>;
}
