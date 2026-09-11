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

// `rename` is applied to the advertised name and defaults to identity, so the
// console-API-key path is byte-identical to what it was before lane (a): only
// the OAuth path — the Claude Code door — gets canonicalized names.
function toAnthropicTool(spec: ToolSpec, rename: (n: string) => string = (n) => n): Anthropic.Tool {
  return { name: rename(spec.name), description: spec.description, input_schema: spec.inputSchema as Anthropic.Tool.InputSchema };
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

// Claude Code 2.x tool names, canonical casing. The OAuth endpoint is the Claude
// Code door and is told it is talking to Claude Code (CLAUDE_CODE_IDENTITY
// above), so a tool of ours that CORRESPONDS to one of these must go out under
// Claude Code's spelling. Mirrored from @earendil-works/pi-ai
// dist/api/anthropic-messages.js:44 (upstream source:
// https://cchistory.mariozechner.at/data/prompts-2.1.11.md, refreshed via
// https://github.com/badlogic/cchistory). Exported so it is greppable when it
// goes stale, which it will — same reason as CLAUDE_CODE_UA_VERSION.
export const CLAUDE_CODE_TOOLS = [
  "Read", "Write", "Edit", "Bash", "Grep", "Glob", "AskUserQuestion",
  "EnterPlanMode", "ExitPlanMode", "KillShell", "NotebookEdit", "Skill",
  "Task", "TaskOutput", "TodoWrite", "WebFetch", "WebSearch",
] as const;

const ccLookup = new Map<string, string>(CLAUDE_CODE_TOOLS.map((t) => [t.toLowerCase(), t]));

/** Outbound: our tool name -> Claude Code's canonical casing when the two
 * correspond case-insensitively, otherwise unchanged. Of raziel's seven
 * builtins exactly two correspond (grep -> Grep, glob -> Glob); `read_file` is
 * NOT `Read` and `fetch` is NOT `WebFetch`, so most names pass straight
 * through. */
export function toClaudeCodeName(name: string): string {
  return ccLookup.get(name.toLowerCase()) ?? name;
}

/** Inbound: Claude Code's spelling -> the name WE advertised, which is what the
 * engine's registry is keyed on.
 *
 * Built from the advertised tool set and NOT from CLAUDE_CODE_TOOLS, and that is
 * the load-bearing half. Canonicalization is lossy in principle — a static table
 * can only invert the names that happen to be in it, so it would hand the engine
 * `Read_File` for an advertised `read_file` and the dispatcher would answer
 * "unknown tool". The only authority on what was advertised is what was
 * advertised. pi-ai's own fromClaudeCodeName takes `tools` for this reason.
 *
 * A name matching nothing advertised is returned UNCHANGED rather than guessed
 * at: inversion must not invent a dispatchable name out of a hallucinated one. */
export function fromClaudeCodeName(name: string, tools?: ToolSpec[]): string {
  if (!tools || tools.length === 0) return name;
  const lower = name.toLowerCase();
  return tools.find((t) => t.name.toLowerCase() === lower)?.name ?? name;
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
 *
 * `toClaudeCodeName` is applied to outbound `tool_use.name` for the same reason
 * PR #2 applies it to the tool declarations: on the OAuth path the names the
 * model was shown are the renamed ones, so replaying its OWN past call under
 * the internal name shows it a call it never made. The rename must be applied
 * everywhere a tool name crosses outbound, and a declaration is not the only
 * place one does.
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

export function toAnthropicMessages(
  messages: ChatMessage[],
  rename?: (name: string) => string,
): Anthropic.MessageParam[] {
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
          name: rename ? rename(c.name) : c.name,
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

/** Mark the LAST content block of the LAST message as the third breakpoint.
 * The cached prefix must GROW with the conversation: inside a tool turn every
 * round appends a tool_use/tool_result pair, and a breakpoint pinned before the
 * newest user message (the first cut of this function, Geist's own spec) left
 * every one of those rounds uncached until the next turn. Marking the tail
 * lets each round read the previous round's prefix; Anthropic's lookup also
 * walks back from a breakpoint, so a moved breakpoint still hits the old one.
 * All cache metadata belongs to fresh wire objects, never the source log.
 */
function cacheableMessages(messages: ChatMessage[], rename?: (name: string) => string): Anthropic.MessageParam[] {
  const mapped = toAnthropicMessages(messages, rename);
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
    const rename = this.oauth ? toClaudeCodeName : undefined;
    // At most three breakpoints: last system, last declaration, stable history.
    // OAuth identity remains the exact FIRST block; persona follows unchanged.
    const system: Anthropic.TextBlockParam[] = [
      ...(this.oauth ? [{ type: "text" as const, text: CLAUDE_CODE_IDENTITY }] : []),
      ...(opts.system ? [{ type: "text" as const, text: opts.system }] : []),
    ];
    if (system.length > 0) system[system.length - 1]!.cache_control = EPHEMERAL;
    const tools = opts.tools?.map(t => toAnthropicTool(t, rename));
    if (tools?.length) tools[tools.length - 1]!.cache_control = EPHEMERAL;
    const stream = this.client.messages.stream({
      model: opts.model,
      max_tokens: 8192,
      ...(system.length > 0 ? { system } : {}),
      messages: cacheableMessages(opts.messages, rename),
      ...(opts.sampling?.temperature !== undefined ? { temperature: opts.sampling.temperature } : {}),
      ...(opts.sampling?.topP !== undefined ? { top_p: opts.sampling.topP } : {}),
      ...(tools?.length ? { tools } : {}),
    });
    opts.signal?.addEventListener("abort", () => stream.abort(), { once: true });

    const queue: QueuedChunk[] = [];
    let done = false; let wake: (() => void) | null = null;
    let streamErr: unknown = null;
    let usage: Anthropic.Usage | undefined;
    stream.on("text", (t: string) => { queue.push({ kind: "delta", text: t }); wake?.(); });

    // Own accumulation of tool_use blocks off the raw event stream — deliberately
    // not the SDK's built-in `inputJson`/`contentBlock` events, which parse
    // partial JSON leniently. R13/R17 require a strict JSON.parse on the fully
    // accumulated string, failing closed (throw, no partial/recovered tool_call)
    // on invalid JSON.
    const toolBlocks = new Map<number, ToolBlockAcc>();
    stream.on("streamEvent", (event) => {
      if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
        // The INVERSE of the outbound rename, and it must be here rather than
        // left to the engine: the registry is keyed on the names we advertised
        // (engine_tool_call.ts looks up `tools.registry.get(call.name)`), so a
        // `Grep` that reached the dispatcher unconverted would answer "unknown
        // tool" — normalizing only outbound turns a working path into a broken
        // one. Inverted against opts.tools, never against CLAUDE_CODE_TOOLS; see
        // fromClaudeCodeName for why a static table is not enough.
        const name = this.oauth ? fromClaudeCodeName(event.content_block.name, opts.tools) : event.content_block.name;
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
    stream.finalMessage().then((message) => { usage = message.usage; }).catch((e) => { streamErr = streamErr ?? e; }).finally(() => { done = true; wake?.(); });

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
    if (!opts.signal?.aborted) yield { type: "done", stopReason: "end" };
  }
}
