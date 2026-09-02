import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage, Provider, StreamChunk, ToolSpec } from "../provider";

// One queued item per emission the generator loop below can yield: a text
// delta or a fully-accumulated tool call. Kept as a discriminated union (not
// separate arrays) so ordering between text and tool_call chunks — as they
// arrived off the wire — is preserved.
type QueuedChunk = { kind: "delta"; text: string } | { kind: "tool_call"; id: string; name: string; args: unknown };

// Per-content-block accumulator for a `tool_use` block: id/name captured at
// content_block_start, `json` accumulated from every input_json_delta's
// partial_json string in order, parsed once at content_block_stop (R13/R17 —
// exactly one tool_call per block, parsed strictly, never a partial/recovered
// value).
type ToolBlockAcc = { id: string; name: string; json: string };

function toAnthropicTool(spec: ToolSpec): Anthropic.Tool {
  return { name: spec.name, description: spec.description, input_schema: spec.inputSchema as Anthropic.Tool.InputSchema };
}

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  private client: Anthropic;

  constructor(opts?: { apiKey?: string; fetchImpl?: typeof fetch }) {
    this.client = new Anthropic({
      apiKey: opts?.apiKey ?? process.env.ANTHROPIC_API_KEY,
      ...(opts?.fetchImpl ? { fetch: opts.fetchImpl } : {}),
    });
  }

  async *stream(opts: {
    model: string; system?: string; messages: ChatMessage[]; signal?: AbortSignal;
    sampling?: { temperature?: number; topP?: number };
    tools?: ToolSpec[];
  }): AsyncIterable<StreamChunk> {
    const stream = this.client.messages.stream({
      model: opts.model,
      max_tokens: 8192,
      system: opts.system,
      messages: opts.messages,
      ...(opts.sampling?.temperature !== undefined ? { temperature: opts.sampling.temperature } : {}),
      ...(opts.sampling?.topP !== undefined ? { top_p: opts.sampling.topP } : {}),
      ...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools.map(toAnthropicTool) } : {}),
    });
    opts.signal?.addEventListener("abort", () => stream.abort(), { once: true });

    const queue: QueuedChunk[] = [];
    let done = false; let wake: (() => void) | null = null;
    let streamErr: unknown = null;
    stream.on("text", (t: string) => { queue.push({ kind: "delta", text: t }); wake?.(); });

    // Own accumulation of tool_use blocks off the raw event stream — deliberately
    // not the SDK's built-in `inputJson`/`contentBlock` events, which parse
    // partial JSON leniently. R13/R17 require a strict JSON.parse on the fully
    // accumulated string, failing closed (throw, no partial/recovered tool_call)
    // on invalid JSON.
    const toolBlocks = new Map<number, ToolBlockAcc>();
    stream.on("streamEvent", (event) => {
      if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
        toolBlocks.set(event.index, { id: event.content_block.id, name: event.content_block.name, json: "" });
      } else if (event.type === "content_block_delta" && event.delta.type === "input_json_delta") {
        const block = toolBlocks.get(event.index);
        if (block) block.json += event.delta.partial_json;
      } else if (event.type === "content_block_stop") {
        const block = toolBlocks.get(event.index);
        if (!block) return;
        toolBlocks.delete(event.index);
        // No input_json_delta ever arrived for this block: ambiguous whether the
        // SDK omits it for genuinely empty-input tools or something else went
        // missing — treat empty as "{}" controller-authorized fallback (Task 7 dispatch ruling, not brief-mandated — revisit when live-API zero-arg behavior is observed).
        const raw = block.json.length > 0 ? block.json : "{}";
        try {
          const args = JSON.parse(raw);
          queue.push({ kind: "tool_call", id: block.id, name: block.name, args });
        } catch (e) {
          streamErr = new Error(
            `anthropic: tool_use block ${block.id} (${block.name}) produced invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
          );
          stream.abort();
        }
        wake?.();
      }
    });

    stream.finalMessage().catch((e) => { streamErr = streamErr ?? e; }).finally(() => { done = true; wake?.(); });

    while (!done || queue.length > 0) {
      if (queue.length === 0) await new Promise<void>((r) => { wake = r; });
      wake = null;
      while (queue.length > 0) {
        if (opts.signal?.aborted) return;
        const item = queue.shift()!;
        if (item.kind === "delta") yield { type: "delta", text: item.text };
        else yield { type: "tool_call", id: item.id, name: item.name, args: item.args };
      }
    }
    if (opts.signal?.aborted) return;
    if (streamErr) throw streamErr instanceof Error ? streamErr : new Error(String(streamErr));
    yield { type: "done", stopReason: "end" };
  }
}
