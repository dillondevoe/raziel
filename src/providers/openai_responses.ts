import { stream as openaiResponsesStream } from "@earendil-works/pi-ai/api/openai-responses";
import type { AssistantMessageEvent, Context, Message, Model, TextContent, Tool, ToolCall as PiToolCall } from "@earendil-works/pi-ai";
import type { ChatMessage, Provider, StreamChunk, ToolSpec } from "../provider";
import { reportedUsage } from "./pi_usage";

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

// THE RAW ARGUMENT STRING IS READ OFF THE WIRE, NOT OFF pi-ai's PARTIAL MESSAGE.
//
// pi-ai's EventStream is a queue, and its producer mutates the tool-call block
// the queued events point at: `partialJson += delta` on every arguments delta,
// `delete partialJson` right before it queues toolcall_end. So anything read
// from `ev.partial` at CONSUME time is whatever the buffer holds then, not what
// it held when the event was pushed. The first version of this file seeded its
// accumulator that way and the review reproduced three breaks (all armed in
// tests/openai-responses-tools.test.ts): a call delivered only as
// output_item.done read `undefined` and ran read_file with {} -- deterministic,
// silent, wrong; a slow consumer read seed+deltas then appended the deltas
// again; and a server that revised its arguments left the accumulator holding
// the superseded text, which the old comment had filed as a "stated limit".
//
// The one string that is authoritative is the `arguments` the server puts on
// `response.output_item.done` -- final, complete, and exactly what the model
// emitted. pi-ai parses it with a lenient repairing parser and discards the
// raw text, but it lets the caller supply `fetch`. So the SDK's fetch is
// wrapped with a pass-through TransformStream that watches the SSE frames as
// they go by and records that string per call, keyed the way pi-ai keys the
// call (`${call_id}|${item.id}`). The transform runs on the bytes BEFORE the
// SDK's parser sees them, so by the time toolcall_end reaches this loop the
// entry exists -- ordering by construction, not by consumer speed. The delta
// accumulator stays as the fallback for a server that omits `arguments` on
// the done item, and it no longer carries a seed, so a slow consumer can no
// longer double anything.
type RawArgs = Map<string, string>;

function tapRawArguments(body: ReadableStream<Uint8Array>, sink: RawArgs): ReadableStream<Uint8Array> {
  const dec = new TextDecoder();
  let buf = "";
  const scan = (line: string): void => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (payload === "" || payload === "[DONE]") return;
    let ev: unknown;
    try { ev = JSON.parse(payload); } catch { return; } // not ours to validate; the SDK will
    const e = ev as { type?: unknown; item?: { type?: unknown; call_id?: unknown; id?: unknown; arguments?: unknown } };
    if (e.type !== "response.output_item.done" || e.item?.type !== "function_call") return;
    if (typeof e.item.arguments !== "string") return;
    sink.set(`${e.item.call_id}|${e.item.id}`, e.item.arguments);
  };
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctl) {
      buf += dec.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        scan(buf.slice(0, nl).replace(/\r$/, ""));
        buf = buf.slice(nl + 1);
      }
      ctl.enqueue(chunk);
    },
    flush() { if (buf.length > 0) scan(buf); },
  }));
}

function tappingFetch(sink: RawArgs, base: typeof fetch): typeof fetch {
  return (async (input, init) => {
    const res = await base(input, init);
    if (!res.body || !(res.headers.get("content-type") ?? "").includes("text/event-stream")) return res;
    return new Response(tapRawArguments(res.body, sink), { status: res.status, statusText: res.statusText, headers: res.headers });
  }) as typeof fetch;
}

export class OpenAIResponsesProvider implements Provider {
  readonly name = PROVIDER_ID;
  private baseUrl: string;
  private apiKey?: string;
  private fetchImpl: typeof fetch;

  constructor(opts: { baseUrl: string; apiKey?: string; fetchImpl?: typeof fetch }) {
    this.baseUrl = opts.baseUrl;
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
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

    const rawArgs: RawArgs = new Map();
    const events = openaiResponsesStream(model, context, {
      apiKey: this.apiKey ?? KEYLESS_API_KEY,
      fetch: tappingFetch(rawArgs, this.fetchImpl),
      signal: opts.signal,
      temperature: opts.sampling?.temperature,
      maxTokens: DEFAULT_MAX_TOKENS,
      ...(Object.keys(samplingParams).length > 0 ? { samplingParams } : {}),
    });

    // pi-ai finalizes arguments with a LENIENT streaming parser
    // (parseStreamingJson), which recovers truncated JSON into a plausible
    // object. A harness that hands tools real filesystem paths must not act on
    // a recovered guess, so the raw text is re-parsed strictly here and the
    // finalized `ev.toolCall.arguments` is never read. The raw text comes from
    // `rawArgs` (the wire tap above); `toolArgs` accumulates deltas as the
    // fallback for a done item that carries no `arguments` string.
    const toolArgs = new Map<number, string>();
    // Tool events are only meaningful when the caller offered tools; a text-only
    // turn carrying a stray tool call must not lose its text to a strict throw.
    const toolsOffered = (opts.tools?.length ?? 0) > 0;
    for await (const ev of events) {
      if (opts.signal?.aborted) return;
      if (!toolsOffered && (ev.type === "toolcall_start" || ev.type === "toolcall_delta" || ev.type === "toolcall_end")) continue;
      if (ev.type === "toolcall_start") {
        toolArgs.set(ev.contentIndex, "");
        continue;
      }
      if (ev.type === "toolcall_delta") {
        const raw = toolArgs.get(ev.contentIndex);
        if (raw === undefined) throw new Error("openai-responses: tool delta without start");
        toolArgs.set(ev.contentIndex, raw + ev.delta);
        continue;
      }
      if (ev.type === "toolcall_end") {
        const streamed = toolArgs.get(ev.contentIndex);
        toolArgs.delete(ev.contentIndex);
        // Wire string first; deltas only if the done item carried none.
        const raw = rawArgs.get(ev.toolCall.id) ?? streamed;
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
      if (ev.type === "done" || (ev.type === "error" && ev.reason !== "aborted")) {
        // Usage first, and before the incomplete-tool-call throw below: the
        // tokens were billed whether or not the rest of this stream is usable.
        // Same ordering as openai_compat, for the same review finding.
        const usage = reportedUsage(ev.type === "done" ? ev.message.usage : ev.error.usage);
        if (usage) yield { type: "usage", usage };
        if (opts.signal?.aborted) return;
      }
      if (ev.type === "done" && toolsOffered && toolArgs.size > 0) throw new Error("openai-responses: incomplete tool call");
      const r = mapEvent(ev);
      if (r.kind === "skip") continue;
      if (r.kind === "throw") throw r.error;
      yield r.chunk;
    }
  }
}
