import { stream as openaiCompletionsStream } from "@earendil-works/pi-ai/api/openai-completions";
import type { AssistantMessageEvent, Context, Message, Model, Tool } from "@earendil-works/pi-ai";
import type { ChatMessage, Provider, StreamChunk, ToolSpec } from "../provider";

const PROVIDER_ID = "openai-compat";
const DEFAULT_CONTEXT_WINDOW = 32_768;
const DEFAULT_MAX_TOKENS = 8192;
// pi-ai's direct api/openai-completions call throws "No API key for provider" unless
// options.apiKey is truthy or an authorization header is set (getClientApiKey in
// openai-completions.js) — even for keyless local servers (Ollama/vLLM/LM Studio).
// This placeholder keeps keyless endpoints working; a real apiKey always overrides it.
const KEYLESS_API_KEY = "not-needed";

// Exported so the RED/GREEN suite (and any future caller) can unit-test the
// event-mapping layer directly against hand-built pi-ai AssistantMessageEvent objects,
// independent of whether the local fake-server route is available.
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
        error: new Error(ev.error.errorMessage ?? `openai-compat provider error: ${ev.reason}`),
      };
    default:
      // Tool events need per-stream accumulation and are handled in stream().
      // Lifecycle and thinking events have no corresponding Provider chunk.
      return { kind: "skip" };
  }
}

function toPiMessage(m: ChatMessage, model: string): Message {
  if (m.role === "user") {
    return { role: "user", content: m.content, timestamp: Date.now() };
  }
  // Our frozen ChatMessage has no notion of pi-ai's richer AssistantMessage (usage,
  // stopReason, provider/model bookkeeping) — synthesize the minimal valid shape so
  // prior assistant turns can be replayed back into context.
  return {
    role: "assistant",
    content: [{ type: "text", text: m.content }],
    api: "openai-completions",
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

export class OpenAICompatProvider implements Provider {
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
    const model: Model<"openai-completions"> = {
      id: opts.model,
      name: opts.model,
      api: "openai-completions",
      provider: PROVIDER_ID,
      baseUrl: this.baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: opts.contextTokens ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
    };

    const context: Context = {
      systemPrompt: opts.system,
      messages: opts.messages.map((m) => toPiMessage(m, opts.model)),
      tools: opts.tools?.map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema as Tool["parameters"] })),
    };

    const samplingParams: Record<string, unknown> = {};
    if (opts.sampling?.topP !== undefined) samplingParams.top_p = opts.sampling.topP;

    const events = openaiCompletionsStream(model, context, {
      apiKey: this.apiKey ?? KEYLESS_API_KEY,
      signal: opts.signal,
      temperature: opts.sampling?.temperature,
      // buildParams reads maxTokens off StreamOptions (this object), not Model.maxTokens —
      // the latter is only consulted inside the reasoning-budget path, which is always off
      // here (model.reasoning === false). Without this, no token cap reaches the wire.
      maxTokens: DEFAULT_MAX_TOKENS,
      ...(Object.keys(samplingParams).length > 0 ? { samplingParams } : {}),
    });

    // pi-ai finalizes arguments with a lenient streaming parser. R13/R17 require
    // parsing the complete raw deltas strictly, not trusting recovered arguments.
    const toolArgs = new Map<number, string>();
    for await (const ev of events) {
      // pi-ai's stream() only checks the abort signal after its own network
      // loop drains — an already-buffered text_delta/done (parsed from the
      // same read as an earlier delta) still arrives here after abort()
      // fires. Guard every iteration, mirroring the ollama provider.
      if (opts.signal?.aborted) return;
      if (ev.type === "toolcall_start") {
        toolArgs.set(ev.contentIndex, "");
        continue;
      }
      if (ev.type === "toolcall_delta") {
        const raw = toolArgs.get(ev.contentIndex);
        if (raw === undefined) throw new Error("openai-compat: tool delta without start");
        toolArgs.set(ev.contentIndex, raw + ev.delta);
        continue;
      }
      if (ev.type === "toolcall_end") {
        const raw = toolArgs.get(ev.contentIndex);
        toolArgs.delete(ev.contentIndex);
        let args: unknown;
        try {
          if (raw === undefined) throw new Error("missing start");
          args = JSON.parse(raw);
        } catch {
          throw new Error("openai-compat: invalid tool JSON");
        }
        const { id, name } = ev.toolCall;
        if (!id || !name) throw new Error("openai-compat: tool call missing id or name");
        yield { type: "tool_call", id, name, args };
        continue;
      }
      if (ev.type === "done" && toolArgs.size > 0) throw new Error("openai-compat: incomplete tool call");
      const r = mapEvent(ev);
      if (r.kind === "skip") continue;
      if (r.kind === "throw") throw r.error;
      yield r.chunk;
    }
  }
}
