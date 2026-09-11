import type { ChatMessage, Provider, StreamChunk, ToolSpec } from "../provider";

// Native calls may carry an id (version-dependent); the join stays positional.
type OllamaToolCall = { id?: string; function: { name: string; arguments: Record<string, unknown> } };
type OllamaMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
  // Ollama accepts (and newer builds echo) a tool name on a result message. It
  // is NOT a second handle on which result is which -- that was measured, and
  // the answer is that the model IGNORES it. Sent anyway, for human
  // readability of a wire dump and for a provider that does honour it.
  //
  // Augur's probes, qwen2.5:7b, 2 parallel calls, 2026-09-10. First round:
  // the join is positional, and a CORRECT tool_call_id is inert. Second round
  // (arm C-prime, run because his first probe sent `content` only and so said
  // nothing about THIS field): results replayed so that name and position
  // DISAGREE. Reversed + correct tool_name -> still swapped; reversed +
  // correct name AND id -> still swapped; and the arm that settles it,
  // IN ORDER + a flatly WRONG tool_name -> still CORRECT. A field that can
  // neither repair a broken join nor corrupt a working one is not
  // participating in the join. The model narrated it unprompted: "based on
  // the first response number... based on the second response number."
  //
  // So nothing in this mapping may lean on it. The positional discipline in
  // toOllamaMessages is the only thing holding, and a dropped or reordered
  // result is NOT recoverable from this field. Open: >2 calls, and repeated
  // same-tool calls, where a name could not disambiguate even in principle.
  tool_name?: string;
};

/** ChatMessage[] -> ollama's native /api/chat message list.
 *
 * THE JOIN IS POSITIONAL, and that is the one thing to be careful about here.
 * Ollama's tool calls may carry an id (version-dependent); the join stays
 * positional. An assistant message holds `tool_calls` in order, and the
 * `role: "tool"` messages that follow are matched to them by
 * ORDER ALONE. So a round's results must be emitted in the same order as its
 * calls and none may be skipped -- dropping a failed one does not lose one
 * result, it silently re-pairs every result after it with the wrong call.
 * That is why a denial replays as an ok:false result with text rather than as
 * an omission, and why this loop never filters.
 *
 * `arguments` is an OBJECT here, not a JSON string as on the OpenAI wire.
 */
export function toOllamaMessages(messages: ChatMessage[], system?: string): OllamaMessage[] {
  const out: OllamaMessage[] = [];
  if (system) out.push({ role: "system", content: system });
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      const calls = m.toolCalls ?? [];
      if (calls.length === 0) { out.push({ role: "assistant", content: m.content }); continue; }
      out.push({
        role: "assistant",
        content: m.content,
        tool_calls: calls.map((c) => ({
          function: { name: c.name, arguments: (c.args ?? {}) as Record<string, unknown> },
        })),
      });
    } else {
      for (const r of m.results) out.push({ role: "tool", content: r.output, tool_name: r.name });
    }
  }
  return out;
}

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
    tools?: ToolSpec[];
  }): AsyncIterable<StreamChunk> {
    const messages = toOllamaMessages(opts.messages, opts.system);
    const toolsOffered = (opts.tools?.length ?? 0) > 0;

    const options: Record<string, unknown> = { num_ctx: opts.contextTokens ?? DEFAULT_CONTEXT_TOKENS };
    if (opts.sampling?.temperature !== undefined) options.temperature = opts.sampling.temperature;
    if (opts.sampling?.topP !== undefined) options.top_p = opts.sampling.topP;

    const res = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: opts.model, messages, stream: true, options,
        ...(toolsOffered ? { tools: opts.tools!.map((t) => ({
          type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema },
        })) } : {}),
      }),
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
      let done: boolean;
      let value: Uint8Array | undefined;
      try {
        ({ done, value } = await reader.read());
      } catch (err) {
        if (opts.signal?.aborted) return;
        throw err instanceof Error ? err : new Error(String(err));
      }
      // Flush a final NDJSON record even when the server omits its trailing newline —
      // but a TRUNCATED trailing record (connection reset mid-line) is not a malformed
      // line to throw on: the deltas already streamed are real. Only append the newline
      // when the residue parses; otherwise leave it in `buf` and end the turn (review).
      if (done) {
        buf += decoder.decode();
        const tail = buf.trim();
        let tailOk = false;
        if (tail) { try { JSON.parse(tail); tailOk = true; } catch { tailOk = false; } }
        if (tailOk) buf += "\n"; else buf = "";
      } else {
        buf += decoder.decode(value, { stream: true });
      }

      let idx: number;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        if (opts.signal?.aborted) return;

        let parsed: { message?: { content?: string; tool_calls?: OllamaToolCall[] }; done?: boolean; prompt_eval_count?: number; eval_count?: number };
        try {
          parsed = JSON.parse(line);
        } catch {
          throw new Error(`ollama /api/chat: malformed NDJSON line: ${line}`);
        }

        if (parsed.done === true) {
          if (opts.signal?.aborted) return;
          if (typeof parsed.prompt_eval_count === "number" && typeof parsed.eval_count === "number") {
            yield { type: "usage", usage: { input_tokens: parsed.prompt_eval_count, output_tokens: parsed.eval_count } };
          }
          if (!opts.signal?.aborted) yield { type: "done", stopReason: "end" };
          return;
        }
        const content = parsed.message?.content;
        if (typeof content === "string" && content.length > 0) {
          if (opts.signal?.aborted) return;
          yield { type: "delta", text: content };
        }
        if (toolsOffered) {
          for (const call of parsed.message?.tool_calls ?? []) {
            if (opts.signal?.aborted) return;
            // Native arguments are already an object. Assign an absent id once
            // for persistence, not for joining Ollama's positional history.
            yield { type: "tool_call", id: call.id ?? crypto.randomUUID(), name: call.function.name, args: call.function.arguments };
          }
        }
      }
      if (done) break;
    }
  }
}
