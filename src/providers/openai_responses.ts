import { stream as openaiResponsesStream } from "@earendil-works/pi-ai/api/openai-responses";
import type { AssistantMessageEvent, Context, Message, Model, TextContent, Tool, ToolCall as PiToolCall } from "@earendil-works/pi-ai";
import type { ChatMessage, Provider, StreamChunk, ToolSpec } from "../provider";

const PROVIDER_ID = "openai-responses";
const DEFAULT_CONTEXT_WINDOW = 32_768;
const DEFAULT_MAX_TOKENS = 8192;
// Same reason as the openai-compat provider: pi-ai's getClientApiKey throws
// "No API key for provider" unless apiKey is truthy, even for keyless servers.
const KEYLESS_API_KEY = "not-needed";

// Exported for the same reason as openai_compat.mapEvent: the suite drives the
// mapping layer directly off hand-built pi-ai events, with no server in the loop.
export type MapResult =
  | { kind: "chunk"; chunk: StreamChunk }
  | { kind: "skip" }
  | { kind: "throw"; error: Error };

export function mapEvent(ev: AssistantMessageEvent): MapResult {
  switch (ev.type) {
    case "text_delta":
      return { kind: "chunk", chunk: { type: "delta", text: ev.delta } };
    case "done":
      return { kind: "chunk", chunk: { type: "done", stopReason: "end" } };
    case "error":
      // stopReason "aborted": return silently, no throw, no done chunk (FakeProvider parity).
      if (ev.reason === "aborted") return { kind: "skip" };
      return {
        kind: "throw",
        error: new Error(ev.error.errorMessage ?? `openai-responses provider error: ${ev.reason}`),
      };
    default:
      // Tool events need per-stream accumulation and are handled in stream().
      // Lifecycle, reasoning and refusal events have no corresponding Provider chunk.
      return { kind: "skip" };
  }
}

function assistantEnvelope(model: string): Omit<Message & { role: "assistant" }, "content"> {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: PROVIDER_ID,
    model,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

/** ChatMessage[] -> pi-ai Message[], which the Responses adapter renders as
 * `function_call` / `function_call_output` items.
 *
 * One shape difference from anthropic, and it is the reason this is not a
 * copy of that mapper: pi-ai models a tool result as its OWN top-level message
 * (`role: "toolResult"`, one per call, carrying `toolCallId`), not as blocks
 * batched into the next user message. So one `role: "tool"` ChatMessage
 * EXPANDS to N pi-ai messages -- hence a mapper returning an array per input
 * rather than one message per input. The join is `toolCallId`, matched against
 * the `id` on the assistant message's toolCall block; on the Responses wire
 * that becomes `call_id`, which the adapter derives from this id, while the
 * item's own `id` is the server's and is not ours to invent.
 *
 * `arguments` is typed `Record<string, any>` by pi-ai but our `args` is
 * `unknown` (it is whatever the model emitted and was strictly parsed). A
 * non-object would be a provider bug upstream of here; `?? {}` keeps a null
 * from becoming a crash in the mapper rather than at the call site.
 */
export function toPiMessages(m: ChatMessage, model: string): Message[] {
  if (m.role === "user") {
    return [{ role: "user", content: m.content, timestamp: Date.now() }];
  }
  if (m.role === "assistant") {
    const content: (TextContent | PiToolCall)[] = [];
    if (m.content.length > 0) content.push({ type: "text", text: m.content });
    for (const c of m.toolCalls ?? []) {
      content.push({ type: "toolCall", id: c.id, name: c.name, arguments: (c.args ?? {}) as PiToolCall["arguments"] });
    }
    if (content.length === 0) return [];
    return [{ ...assistantEnvelope(model), content }];
  }
  return m.results.map((r): Message => ({
    role: "toolResult",
    toolCallId: r.id,
    toolName: r.name,
    content: [{ type: "text", text: r.output }],
    isError: !r.ok,
    timestamp: Date.now(),
  }));
}

// The Responses adapter seeds a tool call's raw-argument buffer at
// `response.output_item.added` time (openai-responses-shared.js createSlot:
// `partialJson: item.arguments || ""`) and pushes NO toolcall_delta for that
// seed. Accumulating deltas alone therefore drops any prefix the server sent
// on the added item — including the whole argument string when a call arrives
// complete in one item, which is what `response.output_item.done` produces for
// a call that never streamed. That prefix is not on the event's own fields; it
// is on the partial AssistantMessage's tool-call block, in a scratch property
// pi-ai deletes on finalize and does not expose in its public ToolCall type.
// Hence the cast — narrow, read-only, and the reason it exists is this comment.
function seedOf(ev: Extract<AssistantMessageEvent, { type: "toolcall_start" }>): string {
  const block = ev.partial.content[ev.contentIndex] as { partialJson?: unknown } | undefined;
  return typeof block?.partialJson === "string" ? block.partialJson : "";
}

export class OpenAIResponsesProvider implements Provider {
  readonly name = PROVIDER_ID;
  private baseUrl: string;
  private apiKey?: string;

  constructor(opts: { baseUrl: string; apiKey?: string }) {
    this.baseUrl = opts.baseUrl;
    this.apiKey = opts.apiKey;
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
    const model: Model<"openai-responses"> = {
      id: opts.model,
      name: opts.model,
      api: "openai-responses",
      provider: PROVIDER_ID,
      baseUrl: this.baseUrl,
      // `reasoning: false` keeps the `reasoning` request field OFF the wire
      // entirely (buildParams gates the whole block on it), leaving the server
      // on its own default effort. gpt-6-astra rejects `reasoning_effort: "none"`
      // outright, so "send nothing" is the only setting known to work here; a
      // profile that wants an explicit effort needs a field AND a live arm, and
      // has neither yet.
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: opts.contextTokens ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
    };

    const context: Context = {
      systemPrompt: opts.system,
      messages: opts.messages.flatMap((m) => toPiMessages(m, opts.model)),
      tools: opts.tools?.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.inputSchema as Tool["parameters"],
      })),
    };

    const samplingParams: Record<string, unknown> = {};
    if (opts.sampling?.topP !== undefined) samplingParams.top_p = opts.sampling.topP;

    const events = openaiResponsesStream(model, context, {
      apiKey: this.apiKey ?? KEYLESS_API_KEY,
      signal: opts.signal,
      temperature: opts.sampling?.temperature,
      maxTokens: DEFAULT_MAX_TOKENS,
      ...(Object.keys(samplingParams).length > 0 ? { samplingParams } : {}),
    });

    // pi-ai finalizes arguments with a LENIENT streaming parser
    // (parseStreamingJson), which recovers truncated JSON into a plausible
    // object. A harness that hands tools real filesystem paths must not act on
    // a recovered guess, so the raw text is re-parsed strictly here and the
    // finalized `ev.toolCall.arguments` is never read.
    //
    // STATED LIMIT, not an oversight: response.function_call_arguments.done
    // replaces the adapter's buffer wholesale but emits a delta ONLY when the
    // final string starts with what was already accumulated. A server that
    // REVISED its arguments mid-stream would therefore leave this accumulator
    // holding the superseded text, with nothing on any event distinguishing
    // that from a normal stream. The failure is loud in the common case (the
    // stale text is usually truncated, so it throws) but not guaranteed to be.
    // Closing it needs a raw-argument field pi-ai does not surface.
    const toolArgs = new Map<number, string>();
    // Tool events are only meaningful when the caller offered tools; a text-only
    // turn carrying a stray tool call must not lose its text to a strict throw.
    const toolsOffered = (opts.tools?.length ?? 0) > 0;
    for await (const ev of events) {
      if (opts.signal?.aborted) return;
      if (!toolsOffered && (ev.type === "toolcall_start" || ev.type === "toolcall_delta" || ev.type === "toolcall_end")) continue;
      if (ev.type === "toolcall_start") {
        toolArgs.set(ev.contentIndex, seedOf(ev));
        continue;
      }
      if (ev.type === "toolcall_delta") {
        const raw = toolArgs.get(ev.contentIndex);
        if (raw === undefined) throw new Error("openai-responses: tool delta without start");
        toolArgs.set(ev.contentIndex, raw + ev.delta);
        continue;
      }
      if (ev.type === "toolcall_end") {
        const raw = toolArgs.get(ev.contentIndex);
        toolArgs.delete(ev.contentIndex);
        let args: unknown;
        try {
          if (raw === undefined) throw new Error("missing start");
          args = raw.trim() === "" ? {} : JSON.parse(raw); // zero-arg call, as in the anthropic provider
        } catch {
          throw new Error("openai-responses: invalid tool JSON");
        }
        const { id, name } = ev.toolCall;
        if (!id || !name) throw new Error("openai-responses: tool call missing id or name");
        yield { type: "tool_call", id, name, args };
        continue;
      }
      if (ev.type === "done" && toolsOffered && toolArgs.size > 0) throw new Error("openai-responses: incomplete tool call");
      const r = mapEvent(ev);
      if (r.kind === "skip") continue;
      if (r.kind === "throw") throw r.error;
      yield r.chunk;
    }
  }
}
