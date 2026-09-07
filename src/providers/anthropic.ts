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

// Two KINDS of credential arrive through the same door. `sk-ant-api03-...` is a
// console API key and bills per token. `sk-ant-oat01-...` is the OAuth token
// `claude setup-token` mints, and it draws on the operator's Claude subscription
// instead. They are not interchangeable on the wire: an API key goes out as
// `x-api-key`, an OAuth token MUST go as `Authorization: Bearer` alongside the
// Claude Code identity. Sniffing the prefix is what the ecosystem already does
// (pi-ai's own `isOAuthToken` is this same substring test), and it means there
// is no such thing as putting the credential in the "wrong" variable — the
// routing follows the credential rather than the operator's memory.
export function isOAuthToken(key: string): boolean {
  return key.includes("sk-ant-oat");
}

// The user-agent version the OAuth endpoint is told it is talking to. Pinned
// rather than read from the local CLI on purpose: this must match what the API
// accepts, not whatever happens to be installed on the machine running raziel
// (they are routinely different — the Dell had 2.1.220 while pi-ai pinned this).
// Named and exported so it is greppable when it goes stale, which it will.
// Provenance: @earendil-works/pi-ai dist/api/anthropic-messages.js:40.
export const CLAUDE_CODE_UA_VERSION = "2.1.75";

// The OAuth endpoint requires the FIRST system block to be exactly this. It is
// not decoration and it is not part of the caller's persona — pi-ai's buildParams
// carries the comment "For OAuth tokens, we MUST include Claude Code identity",
// and a caller's own system prompt is APPENDED as a second block, never
// substituted for this one. Headers alone are not enough to make an OAuth token
// work; this is the half that is easy to miss because the header change is the
// half that gets written down.
export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

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

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  private client: Anthropic;
  private oauth: boolean;

  constructor(opts?: { apiKey?: string; fetchImpl?: typeof fetch }) {
    const key = opts?.apiKey ?? process.env.ANTHROPIC_API_KEY;
    this.oauth = !!key && isOAuthToken(key);
    this.client = new Anthropic({
      // An OAuth token passed as `apiKey` becomes an `x-api-key` header and the
      // API answers "API key is invalid" — a transport error wearing an
      // auth-error costume, for a credential that is perfectly good. `apiKey`
      // must be null so the SDK does not also send that header.
      ...(this.oauth
        ? {
            apiKey: null,
            authToken: key,
            defaultHeaders: {
              "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
              "user-agent": `claude-cli/${CLAUDE_CODE_UA_VERSION}`,
              "x-app": "cli",
            },
          }
        : { apiKey: key }),
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
      // On the OAuth path the identity block leads and the caller's own system
      // prompt follows it. On the API-key path this is unchanged from before.
      ...(this.oauth
        ? {
            system: [
              { type: "text" as const, text: CLAUDE_CODE_IDENTITY },
              ...(opts.system ? [{ type: "text" as const, text: opts.system }] : []),
            ],
          }
        : { system: opts.system }),
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
    if (streamErr) throw asProviderError(streamErr);
    yield { type: "done", stopReason: "end" };
  }
}
