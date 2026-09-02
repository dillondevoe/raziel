import type { ChatMessage, Provider, StreamChunk, ToolSpec } from "../provider";

export class FakeProvider implements Provider {
  readonly name = "fake";
  calls: ChatMessage[][] = [];
  optsLog: Array<{ model: string; sampling?: unknown; contextTokens?: number; tools?: ToolSpec[] }> = [];
  private i = 0;
  private toolScript: { name: string; args: unknown }[] = [];

  constructor(private scripts: string[][]) {}

  scriptTool(name: string, args: unknown): void {
    this.toolScript.push({ name, args });
  }

  async *stream(opts: {
    model: string; system?: string; messages: ChatMessage[]; signal?: AbortSignal;
    sampling?: { temperature?: number; topP?: number }; contextTokens?: number; tools?: ToolSpec[];
  }): AsyncIterable<StreamChunk> {
    this.calls.push(opts.messages);
    this.optsLog.push({ model: opts.model, sampling: opts.sampling, contextTokens: opts.contextTokens, tools: opts.tools });
    const script = this.scripts[this.i++] ?? [];
    for (const text of script) {
      if (opts.signal?.aborted) return;
      yield { type: "delta", text };
    }
    for (const tool of this.toolScript) {
      if (opts.signal?.aborted) return;
      yield { type: "tool_call", id: crypto.randomUUID(), name: tool.name, args: tool.args };
    }
    if (!opts.signal?.aborted) yield { type: "done", stopReason: "end" };
  }
}
