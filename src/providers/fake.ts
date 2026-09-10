import type { ChatMessage, Provider, StreamChunk, ToolSpec, TokenUsage } from "../provider";

export class FakeProvider implements Provider {
  readonly name = "fake";
  calls: ChatMessage[][] = [];
  // `system` is recorded here for the same reason the others are: it is a
  // stream() input a test may need to assert on. It was absent until 2026-09-07,
  // which is precisely why nothing noticed that no call site ever set it.
  optsLog: Array<{ model: string; system?: string; sampling?: unknown; contextTokens?: number; tools?: ToolSpec[] }> = [];
  private i = 0;
  private toolScript: { name: string; args: unknown }[] = [];

  constructor(private scripts: string[][], private usageScripts: (TokenUsage | undefined)[] = []) {}

  scriptTool(name: string, args: unknown): void {
    this.toolScript.push({ name, args });
  }

  async *stream(opts: {
    model: string; system?: string; messages: ChatMessage[]; signal?: AbortSignal;
    sampling?: { temperature?: number; topP?: number }; contextTokens?: number; tools?: ToolSpec[];
  }): AsyncIterable<StreamChunk> {
    this.calls.push(opts.messages);
    this.optsLog.push({ model: opts.model, system: opts.system, sampling: opts.sampling, contextTokens: opts.contextTokens, tools: opts.tools });
    const usage = this.usageScripts[this.i];
    const script = this.scripts[this.i++] ?? [];
    for (const text of script) {
      if (opts.signal?.aborted) return;
      yield { type: "delta", text };
    }
    for (const tool of this.toolScript) {
      if (opts.signal?.aborted) return;
      yield { type: "tool_call", id: crypto.randomUUID(), name: tool.name, args: tool.args };
    }
    if (!opts.signal?.aborted && usage !== undefined) yield { type: "usage", usage };
    if (!opts.signal?.aborted) yield { type: "done", stopReason: "end" };
  }
}
