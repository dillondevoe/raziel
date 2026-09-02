import type { ChatMessage, Provider, StreamChunk } from "../provider";

export class FakeProvider implements Provider {
  readonly name = "fake";
  calls: ChatMessage[][] = [];
  optsLog: Array<{ model: string; sampling?: unknown }> = [];
  private i = 0;

  constructor(private scripts: string[][]) {}

  async *stream(opts: {
    model: string; system?: string; messages: ChatMessage[]; signal?: AbortSignal;
    sampling?: { temperature?: number; topP?: number };
  }): AsyncIterable<StreamChunk> {
    this.calls.push(opts.messages);
    this.optsLog.push({ model: opts.model, sampling: opts.sampling });
    const script = this.scripts[this.i++] ?? [];
    for (const text of script) {
      if (opts.signal?.aborted) return;
      yield { type: "delta", text };
    }
    if (!opts.signal?.aborted) yield { type: "done", stopReason: "end" };
  }
}
