import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage, Provider, StreamChunk } from "../provider";

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  private client: Anthropic;

  constructor(opts?: { apiKey?: string }) {
    this.client = new Anthropic({ apiKey: opts?.apiKey ?? process.env.ANTHROPIC_API_KEY });
  }

  async *stream(opts: {
    model: string; system?: string; messages: ChatMessage[]; signal?: AbortSignal;
    sampling?: { temperature?: number; topP?: number };
  }): AsyncIterable<StreamChunk> {
    const stream = this.client.messages.stream({
      model: opts.model,
      max_tokens: 8192,
      system: opts.system,
      messages: opts.messages,
      ...(opts.sampling?.temperature !== undefined ? { temperature: opts.sampling.temperature } : {}),
      ...(opts.sampling?.topP !== undefined ? { top_p: opts.sampling.topP } : {}),
    });
    opts.signal?.addEventListener("abort", () => stream.abort(), { once: true });

    const queue: string[] = [];
    let done = false; let wake: (() => void) | null = null;
    let streamErr: unknown = null;
    stream.on("text", (t: string) => { queue.push(t); wake?.(); });
    stream.finalMessage().catch((e) => { streamErr = e; }).finally(() => { done = true; wake?.(); });

    while (!done || queue.length > 0) {
      if (queue.length === 0) await new Promise<void>((r) => { wake = r; });
      wake = null;
      while (queue.length > 0) {
        if (opts.signal?.aborted) return;
        yield { type: "delta", text: queue.shift()! };
      }
    }
    if (opts.signal?.aborted) return;
    if (streamErr) throw streamErr instanceof Error ? streamErr : new Error(String(streamErr));
    yield { type: "done", stopReason: "end" };
  }
}
