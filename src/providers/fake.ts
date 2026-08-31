import type { ChatMessage, Provider, StreamChunk } from "../provider";

export class FakeProvider implements Provider {
  readonly name = "fake";
  calls: ChatMessage[][] = [];
  private i = 0;

  constructor(private scripts: string[][]) {}

  async *stream(opts: { model: string; messages: ChatMessage[]; signal?: AbortSignal })
    : AsyncIterable<StreamChunk> {
    this.calls.push(opts.messages);
    const script = this.scripts[this.i++] ?? [];
    for (const text of script) {
      if (opts.signal?.aborted) return;
      yield { type: "delta", text };
    }
    if (!opts.signal?.aborted) yield { type: "done", stopReason: "end" };
  }
}
