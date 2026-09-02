import type { ChatMessage, Provider, StreamChunk } from "../provider";

type OllamaMessage = { role: "system" | "user" | "assistant"; content: string };

const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
// The silent-4K default is ollama's — never let it apply. See landscape scan.
const DEFAULT_CONTEXT_TOKENS = 32768;

export class OllamaProvider implements Provider {
  readonly name = "ollama";
  private baseUrl: string;
  private fetchImpl: typeof fetch;

  constructor(opts?: { baseUrl?: string; fetchImpl?: typeof fetch }) {
    this.baseUrl = opts?.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = opts?.fetchImpl ?? fetch;
  }

  async *stream(opts: {
    model: string;
    system?: string;
    messages: ChatMessage[];
    signal?: AbortSignal;
    sampling?: { temperature?: number; topP?: number };
    contextTokens?: number;
  }): AsyncIterable<StreamChunk> {
    const messages: OllamaMessage[] = [];
    if (opts.system) messages.push({ role: "system", content: opts.system });
    for (const m of opts.messages) messages.push({ role: m.role, content: m.content });

    const options: Record<string, unknown> = { num_ctx: opts.contextTokens ?? DEFAULT_CONTEXT_TOKENS };
    if (opts.sampling?.temperature !== undefined) options.temperature = opts.sampling.temperature;
    if (opts.sampling?.topP !== undefined) options.top_p = opts.sampling.topP;

    const res = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: opts.model, messages, stream: true, options }),
      signal: opts.signal,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`ollama /api/chat ${res.status}: ${body}`);
    }
    if (!res.body) throw new Error("ollama /api/chat: empty response body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    while (true) {
      if (opts.signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        if (opts.signal?.aborted) return;

        let parsed: { message?: { content?: string }; done?: boolean };
        try {
          parsed = JSON.parse(line);
        } catch {
          throw new Error(`ollama /api/chat: malformed NDJSON line: ${line}`);
        }

        if (parsed.done === true) {
          if (opts.signal?.aborted) return;
          yield { type: "done", stopReason: "end" };
          return;
        }
        const content = parsed.message?.content;
        if (typeof content === "string" && content.length > 0) {
          if (opts.signal?.aborted) return;
          yield { type: "delta", text: content };
        }
      }
    }
  }
}
