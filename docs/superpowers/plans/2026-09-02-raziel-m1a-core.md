# Raziel M1a (Core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raziel converses with cloud AND local models through first-class model profiles — M0's debt paid, an ollama-native provider, a pi-ai-backed OpenAI-compatible provider, and `/model` hot-swap — the conversational half of the daily-driver bar.

**Architecture:** Model profiles become the engine's currency (a profile names its provider + budgets + quirks); three providers sit behind the frozen `Provider` interface (our Anthropic adapter unchanged, a NEW native ollama `/api/chat` adapter, a NEW pi-ai `openai-completions` adapter for generic endpoints). Verified fact driving this: pi-ai has **no** native ollama adapter (its `KnownApi` has no "ollama"; ollama only via the `/v1` shim, which is known-broken for streaming+tools) — see the API authority doc.

**Tech Stack:** Bun + TypeScript strict; `@anthropic-ai/sdk` (existing); `@earendil-works/pi-ai` **pinned exactly 0.84.4**; no other new deps.

**Spec:** `docs/SPEC.md` (§3.3 model profiles = lane 1; §3.5 provider layer). **API authority for pi-ai symbols: `docs/pi-api-reference.md`** (verified against installed .d.ts, compile-checked) — when this plan's code and that file disagree, the reference wins; adapt inside the task and note it.

## Global Constraints

- TypeScript strict; EVERY task runs `bun run typecheck; echo "exit=$?"` (must be 0) AND full `bun test` before committing — RAW outputs in reports.
- TDD: failing test first with RAW RED evidence, then implement.
- Source files < ~200 lines; no default exports; events append-only; `id`/`ts` machine-stamped in `mkEvent` only.
- Tests set `RAZIEL_HOME` to a `mkdtempSync` dir in `beforeEach`; never touch `~/.raziel`.
- The `Provider` interface (src/provider.ts) is FROZEN: `stream(opts: { model: string; system?: string; messages: ChatMessage[]; signal?: AbortSignal }): AsyncIterable<StreamChunk>`; StreamChunk = `{type:"delta",text}` | `{type:"done",stopReason:"end"|"error"}`. Providers THROW on failure (engine converts); after abort: no further chunks, no done.
- Network-dependent checks are GATED: skip cleanly with an explicit report note when the endpoint/key is absent; never hunt for credentials.
- Commit at end of every task with the given message; push to origin main.

---

### Task 1: M0 debt burn-down (batched same-shape fixes)

**Files:**
- Modify: `src/engine.ts` (chunk-dispatch ordering), `src/cli.ts` (extract SIGINT handler factory), `src/session.ts` (list ordering), `package.json` (pin @types/bun)
- Test: `tests/engine.test.ts` (race test), `tests/sigint.test.ts` (new), `tests/session.test.ts` (ordering test)

**Interfaces:**
- Consumes: existing engine/session/cli internals.
- Produces: `makeSigintHandler(deps: { signalRef: { current: AbortController | null }; isClosed: () => boolean; exit: (code: number) => void; write: (s: string) => void }): () => void` exported from `src/cli.ts` — later tasks and tests use it; runtime behavior unchanged.

- [ ] **Step 1: Write the failing race test** — append to `tests/engine.test.ts`:

```ts
test("done chunk delivered in the same tick as abort still counts as end", async () => {
  const store = new SessionStore("race1");
  // Provider that flips the abort flag and THEN yields done in the same resumption,
  // so the engine's loop sees aborted===true on the very delivery carrying done.
  let ctl!: AbortController;
  const p = {
    name: "race",
    async *stream(): AsyncIterable<{ type: "delta"; text: string } | { type: "done"; stopReason: "end" }> {
      yield { type: "delta", text: "full" };
      ctl.abort();                       // abort visible BEFORE the done chunk is dispatched
      yield { type: "done", stopReason: "end" };
    },
  };
  const eng = new Engine({ provider: p as any, store, model: "m" });
  ctl = new AbortController();
  for await (const _ of eng.send("go", { signal: ctl.signal })) { /* drain */ }
  const end = store.replay().at(-1) as any;
  expect(end.type).toBe("turn_end");
  expect(end.stop).toBe("end");          // completed turn must not be mislabeled interrupt
});
```

- [ ] **Step 2: Run to verify it fails** — `bun test tests/engine.test.ts` → the new test FAILS (current code breaks on the abort check before dispatching the done chunk → stop "interrupt").

- [ ] **Step 3: Fix ordering in `src/engine.ts`** — inside the for-await loop, dispatch `done` BEFORE the abort check:

```ts
for await (const chunk of provider.stream({ model, system, messages: this.context(), signal: o?.signal })) {
  if (chunk.type === "done") { sawDone = true; continue; }   // a delivered done is always recorded
  if (o?.signal?.aborted) { interrupted = true; break; }
  if (chunk.type === "delta") { acc += chunk.text; yield { type: "assistant_delta", turn, text: chunk.text }; }
}
```
(Only the ordering moves; the post-loop stop computation is unchanged.)

- [ ] **Step 4: Run to verify pass** — the race test AND all existing engine tests PASS (the mid-stream abort test still breaks on the delta following the abort).

- [ ] **Step 5: Extract + test the SIGINT handler** — in `src/cli.ts`, extract the current double-tap logic into the exported factory `makeSigintHandler` (shape in Interfaces above); `main()` builds `deps` from the real process/rl (`isClosed: () => rlClosed`, `exit: process.exit`, `write: (s) => process.stdout.write(s)`) and registers the SAME returned handler on both `process.on("SIGINT")` and `rl.on("SIGINT", ...)` exactly as today. New `tests/sigint.test.ts`:

```ts
import { test, expect } from "bun:test";
import { makeSigintHandler } from "../src/cli";

test("first tap aborts in-flight turn without clearing ref; second mid-finish tap re-aborts, no exit", () => {
  const ctl = new AbortController();
  const ref = { current: ctl as AbortController | null };
  let exited = -1;
  const h = makeSigintHandler({ signalRef: ref, isClosed: () => false, exit: (c) => { exited = c; }, write: () => {} });
  h();
  expect(ctl.signal.aborted).toBe(true);
  expect(ref.current).toBe(ctl);       // NOT cleared by the handler (single-clearer rule)
  h();                                  // turn still finishing — must not exit
  expect(exited).toBe(-1);
});

test("tap when idle exits 0 with farewell", () => {
  let exited = -1; let out = "";
  const h = makeSigintHandler({ signalRef: { current: null }, isClosed: () => false, exit: (c) => { exited = c; }, write: (s) => { out += s; } });
  h();
  expect(exited).toBe(0);
  expect(out).toContain("bye");
});
```
RED first (export missing), then implement, then GREEN.

- [ ] **Step 6: Session list ordering by mtime** — failing test in `tests/session.test.ts`: create sessions "b-name" then "a-name" (touch order matters, names sort wrongly lexicographically); expect `SessionStore.list()[0]` === "a-name". Fix `list()` to sort by file mtime descending (`statSync(...).mtimeMs`), falling back to name for ties.

- [ ] **Step 7: Pin @types/bun** — replace `"latest"` with the exact version currently resolved (read it from `bun.lock` or `bun pm ls`); `bun install`; `bun install --frozen-lockfile` must pass.

- [ ] **Step 8: Full gates + commit** — `bun run typecheck; echo "exit=$?"` (0), full `bun test`; commit `fix: M0 debt — done-before-abort ordering, testable SIGINT handler, mtime session order, pinned types` and push.

---

### Task 2: Model profiles

**Files:**
- Create: `src/profiles.ts` · Test: `tests/profiles.test.ts`
- Modify: `src/engine.ts` (accept profile), `src/cli.ts` (resolve profile)

**Interfaces:**
- Produces (later tasks rely on, verbatim):

```ts
export type ParserKind = "native";                     // M1b adds "hermes-json" | "qwen-xml"
export type ModelProfile = {
  id: string;              // registry key AND what /model matches
  provider: "anthropic" | "ollama" | "openai-compat";
  model: string;           // provider-side model name
  baseUrl?: string;        // ollama / openai-compat endpoints
  contextTokens: number;   // budget the engine may assume
  maxToolSurface: number;  // enforced in M1b; carried now
  parser: ParserKind;
  sampling?: { temperature?: number; topP?: number };
  streamingTools: boolean; // carried for M1b
  escalateTo?: string;     // profile id offered on local punt (M1c UX)
};
export function getProfile(id: string): ModelProfile | undefined;
export function listProfiles(): ModelProfile[];
export function defaultProfileId(): string;            // "sonnet"
```

- Registry contents (exact):

```ts
const REGISTRY: ModelProfile[] = [
  { id: "sonnet", provider: "anthropic", model: "claude-sonnet-5",
    contextTokens: 200_000, maxToolSurface: 24, parser: "native", streamingTools: true },
  { id: "qwen", provider: "ollama", model: "qwen3.5:9b",
    baseUrl: "http://127.0.0.1:11434", contextTokens: 32_768, maxToolSurface: 6,
    parser: "native", sampling: { temperature: 0.7, topP: 0.8 }, streamingTools: false,
    escalateTo: "sonnet" },
];
```
(qwen numbers are the landscape-scan doctrine: 32K forced context, small tool surface, 0.7/0.8 sampling, never greedy.)

- Engine change (backward compatible): `Engine` opts gain optional `profile?: ModelProfile`; when present, `model` is taken from the profile and `profile.sampling` is passed through to the provider via a widened — but still frozen-compatible — options object: add OPTIONAL `sampling?: { temperature?: number; topP?: number }` to `Provider.stream`'s opts type (optional field addition; every existing implementor stays valid). Providers MAY ignore it (Anthropic adapter passes temperature/top_p when present).

- [ ] Steps: failing tests for `getProfile`/`listProfiles`/`defaultProfileId` + a test that `new Engine({provider, store, profile: getProfile("qwen")!})` streams with `model === "qwen3.5:9b"` (FakeProvider records the model it was called with — extend `FakeProvider.calls` to also record opts: add `optsLog: Array<{model: string; sampling?: unknown}>`); RED → implement → GREEN → full gates → commit `feat: model profiles — the registry the whole of M1 hangs on` → push.

---

### Task 3: Ollama native /api/chat provider

**Files:**
- Create: `src/providers/ollama.ts` · Test: `tests/ollama-provider.test.ts` (fixture-driven, no network)

**Interfaces:**
- Produces: `class OllamaProvider implements Provider` — `constructor(opts?: { baseUrl?: string })` (default `http://127.0.0.1:11434`); `stream()` POSTs `${baseUrl}/api/chat` with body `{ model, messages: [ {role:"system"?}...], stream: true, options: { num_ctx, temperature?, top_p? } }` where `num_ctx` comes from a NEW optional `stream` opt `contextTokens?: number` (second optional addition to the Provider opts type; default 32768 when absent — the silent-4K killer from the landscape scan must never happen). `system` is prepended as a `{role:"system"}` message. Parses NDJSON lines: each `{message:{content}, done:false}` → `{type:"delta",text}`; final `{done:true}` → `{type:"done",stopReason:"end"}`; non-2xx or malformed JSON → THROW with the body text; abort via `fetch(..., { signal })` + per-yield abort guard (FakeProvider parity).
- Testability: `constructor` accepts optional `fetchImpl?: typeof fetch` (defaults to global) — tests inject a fake returning a `ReadableStream` of NDJSON bytes.

- [ ] Steps: failing tests — (a) happy path: fake fetch streams three NDJSON lines (two content chunks + done) → deltas "He","y" then done; body assertion: fake captures the request, test asserts `options.num_ctx === 32768` default and message shapes; (b) abort mid-stream: no further chunks, no done; (c) HTTP 500 with body → stream() iteration rejects with the body in the message; (d) `num_ctx` honored when `contextTokens` passed. RED → implement (~120 lines: fetch, reader loop over `res.body.getReader()`, line-buffered NDJSON split, guards) → GREEN → full gates.
- [ ] **Gated live check**: if `curl -s --max-time 2 http://127.0.0.1:11434/api/tags` succeeds AND lists any model, run one real single-prompt stream against the first listed model and paste the raw output; else state SKIPPED (no local ollama) — do not fail the task on absence.
- [ ] Commit `feat: native ollama /api/chat provider — 32K context floor, NDJSON streaming` → push.

---

### Task 4: OpenAI-compatible provider via pi-ai

**Files:**
- Create: `src/providers/openai_compat.ts` · Test: `tests/openai-compat-provider.test.ts`
- Modify: `package.json` (add `"@earendil-works/pi-ai": "0.84.4"` — EXACT pin, no caret)

**Interfaces:**
- Produces: `class OpenAICompatProvider implements Provider` — `constructor(opts: { baseUrl: string; apiKey?: string })`. Uses pi-ai's DIRECT streaming path (auth-manager bypassed): import from the `@earendil-works/pi-ai/api/openai-completions` subpath per `docs/pi-api-reference.md` (THE authority — take the exact function name, options shape, and event union from that file's pi-ai section; if the subpath or symbol differs from this plan's sketch, follow the reference and note the adaptation in your report). Map pi-ai's `AssistantMessageEvent` union → our chunks: `text_delta`-class events (by `contentIndex`, concatenated in arrival order) → `{type:"delta"}`; terminal `done` → `{type:"done",stopReason:"end"}`; `error` event or `stopReason:"error"` → THROW (engine's path); `stopReason:"aborted"` → return silently (no done). Abort: pass `signal` through pi-ai's `StreamOptions.signal`. Ignore `thinking_*`/`toolcall_*` events in M1a (M1b consumes tool calls).
- Wire-up note for Task 5: profiles with `provider:"openai-compat"` construct this with the profile's `baseUrl`.

- [ ] Steps: RED tests first — since pi-ai speaks HTTP underneath, test via a LOCAL fake OpenAI-compatible server: start `Bun.serve` on port 0 in the test emitting a canned SSE `chat.completions` stream (two content deltas + `[DONE]`), point the provider's baseUrl at it; assert joined deltas + done; second test: server returns 401 JSON error → iteration rejects; third: abort after first delta → no further chunks, no done. (If pi-ai's client refuses the fake server for a reason the reference explains — e.g. mandatory model catalog — fall back to testing the EVENT-MAPPING layer directly: export the internal `mapEvent(ev): StreamChunk | "skip" | "throw"` and unit-test it against hand-built pi-ai event objects verbatim from the reference; state which route you took.) → implement → GREEN → full gates.
- [ ] Commit `feat: OpenAI-compatible provider on pi-ai 0.84.4 — Nous/Camelid/vLLM reachable` → push.

---

### Task 5: Profile-aware CLI + /model hot-swap

**Files:**
- Modify: `src/cli.ts` (provider factory from profile, `--profile` flag, `/model` command), `src/book.ts` (no change expected — verify)
- Test: `tests/cli.test.ts` (extend)

**Interfaces:**
- Produces: `providerFor(p: ModelProfile, fetchImpl?: typeof fetch): Provider` exported from `src/cli.ts` — switch on `p.provider`: `"anthropic"` → existing `AnthropicProvider` (key guard stays); `"ollama"` → `OllamaProvider({baseUrl: p.baseUrl})`; `"openai-compat"` → `OpenAICompatProvider({baseUrl: p.baseUrl!, apiKey: process.env.RAZIEL_COMPAT_KEY})`.
- CLI: `--profile <id>` (default `defaultProfileId()`); `--model` retained as a raw-model override on the anthropic path (back-compat for M0 smokes — document precedence: `--profile` wins when both given).
- `/model` REPL command: bare `/model` lists profiles (id, provider, model, marks current); `/model <id>` swaps — implemented by rebuilding the Engine with the new profile + SAME SessionStore (the event log is the continuity; a swap is legal mid-session by design). Status line reprints with the new profile. Unknown id → one-line error, no crash.
- `runRepl` gains optional `onCommand?: (line: string) => "handled" | "not-command"` hook consulted before treating input as a prompt — main() supplies the /model handler; tests drive it directly.

- [ ] Steps: RED tests — (a) `providerFor` returns the right class per profile (instanceof checks, fake fetch injected for ollama); (b) runRepl routes `/model qwen` through `onCommand` and does NOT call engine.send; (c) swap integration: fake-provider REPL, send one line, `/model` to a second profile whose FakeProvider script differs, send another line — session log contains BOTH turns in one file. → implement → GREEN → full gates.
- [ ] Manual smokes: piped fake smoke byte-stable; `--profile qwen` against live ollama IF present (gated as Task 3), else skipped-with-note.
- [ ] Commit `feat: profile-aware CLI + /model hot-swap — one session, many minds` → push.

---

## Self-review (authoring)

- **Spec coverage (M1a scope):** profiles (spec §3.3 core) T2; provider layer §3.5 completed for 3 backends T3/T4; /model hot-swap (spec §4 bullet) T5; M0 parked debt (final-review residual race, SIGINT test, ordering, pin) T1. Tools/approvals/TUI deliberately M1b/M1c.
- **Placeholders:** none; the one intentional indirection (pi-ai exact symbols) is delegated to a VERIFIED in-repo authority file with explicit adapt-and-note license — that is the anti-placeholder mechanism for a third-party API, not a TBD.
- **Type consistency:** Provider opts gain two OPTIONAL fields (`sampling?`, `contextTokens?`) — additive, all M0 implementors remain valid; `ModelProfile` field names match between T2 registry and T5 factory; `makeSigintHandler` deps shape matches T1 test usage.
