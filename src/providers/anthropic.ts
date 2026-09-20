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

// A Claude SUBSCRIPTION token (`sk-ant-oat…`, minted by `claude setup-token`) is
// REFUSED here, on purpose. The only way to make that token work outside Claude
// Code is to present this program AS Claude Code — its user-agent, its "You are
// Claude Code" identity block, its tool names — and raziel did exactly that until
// 2026-09-20. That is impersonating another product to the vendor, against
// Anthropic's terms for subscription credentials, and it put the operator's whole
// plan at risk for a convenience. Removed, not hidden behind a flag: a flag is a
// path someone turns back on. This door takes a console API key (`sk-ant-api…`,
// billed per token); subscription use belongs to Claude Code itself.
export function isOAuthToken(key: string): boolean {
  return key.includes("sk-ant-oat");
}

export const OAUTH_REFUSAL =
  "anthropic: this is a Claude subscription token (sk-ant-oat…). Raziel does not accept it — using it " +
  "outside Claude Code requires impersonating Claude Code. Use a console API key (sk-ant-api…) or another provider.";

// On a subscription, 429 is the STEADY STATE near the plan ceiling, not a
// malfunction — Dillon exhausts Max 20x most weeks — so it must not read like
// one. The SDK already retries with exponential backoff honouring `retry-after`;
// adding a second retry layer here would only make the wait longer and less
// legible. What was missing is that the surfaced error said nothing about which
// of the two ceilings was hit, or that waiting is the correct response.
export function asProviderError(err: unknown): Error {
  const e = err instanceof Error ? err : new Error(String(err));
  const status = (err as { status?: number } | null)?.status;
  if (status !== 429) return e;
  const headers = (err as { headers?: Record<string, string> | Headers } | null)?.headers;
  const get = (n: string): string | undefined =>
    headers instanceof Headers ? headers.get(n) ?? undefined : (headers as Record<string, string> | undefined)?.[n];
  const retryAfter = get("retry-after");
  return new Error(
    "anthropic: rate limited (429) — this is your plan's usage ceiling, not a bad credential. " +
      (retryAfter ? `Retry after ${retryAfter}s. ` : "Retry shortly. ") +
      `Original: ${e.message}`,
  );
}


/** ChatMessage[] -> Anthropic MessageParam[].
 *
 * Two wire facts drive the whole shape:
 *
 * - A round's tool_use blocks live on ONE assistant message, and every matching
 *   tool_result block must arrive together on the NEXT message, which is
 *   role "user" (anthropic has no "tool" role). Splitting a round's results
 *   across messages, or omitting one, is a 400 -- so the batched `role: "tool"`
 *   message maps one-to-one onto one user message of tool_result blocks.
 * - `content: ""` is REJECTED by the API on an assistant message. A mid-turn
 *   round legitimately has no prose, so an empty text block must be omitted
 *   rather than sent -- the tool_use blocks are the content.
 */
/** The Messages API requires `tool_use.id` to match ^[a-zA-Z0-9_-]+$ and be at
 * most 64 characters. Ids in the log are whatever the ORIGINATING provider
 * issued: anthropic's own `toolu_…` already fit; the Responses provider
 * persists pi-ai's `${call_id}|${item_id}` -- a `|`, plus an fc_ item id that
 * can run to hundreds of chars -- and /model or /session can bring such a
 * session here. Applied to BOTH sides of the join so it cannot split them, and
 * the cut keeps the head, which is where the unique call_id sits. pi-ai's own
 * anthropic adapter does the same; this tree drives the SDK directly, so it
 * inherited none of that. Idempotent on an id that already fits. */
export function toAnthropicToolId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

export function toAnthropicMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (m.content.length > 0) blocks.push({ type: "text", text: m.content });
      for (const c of m.toolCalls ?? []) {
        blocks.push({
          type: "tool_use",
          id: toAnthropicToolId(c.id),
          name: c.name,
          input: (c.args ?? {}) as Record<string, unknown>,
        });
      }
      // An assistant message with neither text nor tool calls has no valid
      // representation here; dropping it is correct and lossless (it carried
      // nothing), whereas sending an empty content array is a 400.
      if (blocks.length > 0) out.push({ role: "assistant", content: blocks });
    } else {
      out.push({
        role: "user",
        content: m.results.map((r): Anthropic.ToolResultBlockParam => ({
          type: "tool_result",
          tool_use_id: toAnthropicToolId(r.id),
          // grep with no matches and read_file on an empty file both return
          // ok:true with "". An empty text BLOCK is rejected by the API; an
          // empty STRING here was not confirmed either way, and a persisted
          // tool round that 400s poisons every later turn of the session, so
          // send a stated absence -- which is also true, and more useful.
          content: r.output.length > 0 ? r.output : "(no output)",
          is_error: !r.ok,
        })),
      });
    }
  }
  return out;
}

const EPHEMERAL = { type: "ephemeral" as const };
// Output budget per round. 8192 was the number until 2026-09-12, when a sonnet-5 round on a design task
// spent exactly 8192 tokens on reasoning and emitted nothing (see the max_tokens guard below). Sonnet/Opus 5
// accept far more; cost accrues only on tokens actually produced, so a high ceiling is not a spend.
export const MAX_TOKENS = 32_000;

/** Mark the LAST content block of the LAST message as the third breakpoint.
 * The cached prefix must GROW with the conversation: inside a tool turn every
 * round appends a tool_use/tool_result pair, and a breakpoint pinned before the
 * newest user message (the first cut of this function, Geist's own spec) left
 * every one of those rounds uncached until the next turn. Marking the tail
 * lets each round read the previous round's prefix; Anthropic's lookup also
 * walks back from a breakpoint, so a moved breakpoint still hits the old one.
 * All cache metadata belongs to fresh wire objects, never the source log.
 */
function cacheableMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
  const mapped = toAnthropicMessages(messages);
  const last = mapped.at(-1);
  if (!last) return mapped;
  if (typeof last.content === "string") {
    if (last.content.length > 0) last.content = [{ type: "text", text: last.content, cache_control: EPHEMERAL }];
  } else {
    const block = last.content.at(-1);
    // These are exactly the block kinds emitted by toAnthropicMessages.
    if (block && (block.type === "text" || block.type === "tool_use" || block.type === "tool_result")) {
      last.content[last.content.length - 1] = { ...block, cache_control: EPHEMERAL };
    }
  }
  return mapped;
}

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  private client: Anthropic;

  constructor(opts?: { apiKey?: string; fetchImpl?: typeof fetch }) {
    const key = opts?.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (key && isOAuthToken(key)) throw new Error(OAUTH_REFUSAL);
    this.client = new Anthropic({
      apiKey: key,
      ...(opts?.fetchImpl ? { fetch: opts.fetchImpl } : {}),
    });
  }

  async *stream(opts: {
    model: string; system?: string; messages: ChatMessage[]; signal?: AbortSignal;
    sampling?: { temperature?: number; topP?: number };
    tools?: ToolSpec[];
  }): AsyncIterable<StreamChunk> {
    // At most three breakpoints: last system, last declaration, stable history.
    const system: Anthropic.TextBlockParam[] = [
      ...(opts.system ? [{ type: "text" as const, text: opts.system }] : []),
    ];
    if (system.length > 0) system[system.length - 1]!.cache_control = EPHEMERAL;
    const tools = opts.tools?.map(t => toAnthropicTool(t));
    if (tools?.length) tools[tools.length - 1]!.cache_control = EPHEMERAL;
    const stream = this.client.messages.stream({
      model: opts.model,
      max_tokens: MAX_TOKENS,
      ...(system.length > 0 ? { system } : {}),
      messages: cacheableMessages(opts.messages),
      ...(opts.sampling?.temperature !== undefined ? { temperature: opts.sampling.temperature } : {}),
      ...(opts.sampling?.topP !== undefined ? { top_p: opts.sampling.topP } : {}),
      ...(tools?.length ? { tools } : {}),
    });
    opts.signal?.addEventListener("abort", () => stream.abort(), { once: true });

    const queue: QueuedChunk[] = [];
    let done = false; let wake: (() => void) | null = null;
    let streamErr: unknown = null;
    let usage: Anthropic.Usage | undefined;
    let sawVisible = false;   // any text delta or tool call reached the consumer
    let stopReason: string | null | undefined;
    stream.on("text", (t: string) => { sawVisible = true; queue.push({ kind: "delta", text: t }); wake?.(); });

    // Own accumulation of tool_use blocks off the raw event stream — deliberately
    // not the SDK's built-in `inputJson`/`contentBlock` events, which parse
    // partial JSON leniently. R13/R17 require a strict JSON.parse on the fully
    // accumulated string, failing closed (throw, no partial/recovered tool_call)
    // on invalid JSON.
    const toolBlocks = new Map<number, ToolBlockAcc>();
    stream.on("streamEvent", (event) => {
      if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
        const name = event.content_block.name;
        toolBlocks.set(event.index, { id: event.content_block.id, name, json: "" });
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

    // The SDK merges message_start/message_delta cumulative counts by overwrite.
    // Use its final snapshot, not a sum of deltas or a second wire parser.
    stream.finalMessage().then((message) => { usage = message.usage; stopReason = message.stop_reason; }).catch((e) => { streamErr = streamErr ?? e; }).finally(() => { done = true; wake?.(); });

    while (!done || queue.length > 0) {
      if (queue.length === 0) await new Promise<void>((r) => { wake = r; });
      wake = null;
      while (queue.length > 0) {
        if (opts.signal?.aborted) return;
        const item = queue.shift()!;
        if (item.kind === "delta") yield { type: "delta", text: item.text };
        else { sawVisible = true; yield { type: "tool_call", id: item.id, name: item.name, args: item.args }; }
      }
    }
    if (opts.signal?.aborted) return;
    if (streamErr) throw asProviderError(streamErr);
    if (stopReason === "max_tokens" && !sawVisible) {
      // Live exhibit 2026-09-12 (sonnet-ships-1 round 3): 8192 output tokens, all of them reasoning,
      // no text, no tool call — and this door said "end". The engine then persisted an EMPTY
      // assistant_message and closed the turn cleanly; the operator saw a prompt and nothing else.
      // A budget stop that produced nothing visible is an error to be recorded, not an end.
      const reasoning = usage?.output_tokens_details?.thinking_tokens;
      throw new Error(
        `anthropic: max_tokens (${MAX_TOKENS}) exhausted with NO visible output — output_tokens=${usage?.output_tokens ?? "?"}` +
        (reasoning != null ? `, reasoning consumed ${reasoning}` : "") +
        `. The model spent the whole budget thinking. Raise MAX_TOKENS, bound the thinking budget, or split the task.`);
    }
    if (usage && typeof usage.input_tokens === "number" && typeof usage.output_tokens === "number") {
      const reasoning = usage.output_tokens_details?.thinking_tokens;
      yield { type: "usage", usage: {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        ...(reasoning != null ? { reasoning_tokens: reasoning } : {}),
        ...(usage.cache_read_input_tokens != null ? { cache_read_tokens: usage.cache_read_input_tokens } : {}),
        ...(usage.cache_creation_input_tokens != null ? { cache_write_tokens: usage.cache_creation_input_tokens } : {}),
      } };
    }
    if (!opts.signal?.aborted) yield { type: "done", stopReason: stopReason === "max_tokens" ? "length" : "end" };
  }
}
