# Raziel M1b — Tools & Approvals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the engine a tool-call loop — built-in tools with computed risk classes, hash-bound approvals, and a standing-rules file — using the provider's structured tool channel only.

**Architecture:** The Provider contract gains an additive tool channel (tool_call chunks + tools option). The engine's turn becomes a bounded loop: stream → structured tool_call → tool_request event (provenance-tagged) → approval (hash-bound to exact args, risk class computed by the executor) → execute → tool_result event → re-stream. Approvals render engine-side through the terminal sanitizer; "always" rules live in a schema-validated config file, never reconstructed from session logs.

**Tech Stack:** TypeScript on Bun (no new runtime deps in this milestone). @anthropic-ai/sdk (already pinned) for the native tool channel.

**Spec:** /Users/dtd/raziel/docs/SPEC.md §3, §6, §7 · **Binding security authority:** /Users/dtd/raziel/docs/security/m1b-security-requirements.md (requirements cited as R6–R17 below) · API notes: docs/pi-api-reference.md

## Global Constraints

- `bun run typecheck` exits 0 before EVERY commit; full `bun test` suite stays green (97 at plan time).
- TDD with RAW RED: failing test first, run it, capture actual output, then implement.
- Files < 200 lines; no default exports; no new runtime dependencies.
- **Provider contract v2 amendment (Task 1) is the ONLY change to src/provider.ts in this milestone.** After Task 1 lands, the interface is re-frozen: `stream(opts: {model, system?, messages, signal?, sampling?, contextTokens?, tools?}): AsyncIterable<StreamChunk>` with StreamChunk gaining exactly one variant: `{ type: "tool_call"; id: string; name: string; args: unknown }`.
- **Structured channel only (R9):** `tool_request` events are constructed ONLY from provider `tool_call` chunks. No text parsing of any kind in this milestone; `ParserKind` stays `"native"`. No greedy/lenient fallback parser exists anywhere (R17).
- **Approval binds to args (R10):** every approval commits to `argsHash = sha256(canonicalJson({tool, args}))`; the executor refuses on hash mismatch.
- **Risk class computed, not declared (R13):** only `riskClassFor(tool, args, workspaceRoot)` produces a risk class; tools carry no self-declared class. Unknown tool or unclassifiable args → `"critical"` (fail closed).
- **Containment (R16):** file tools resolve() and prefix-check against `workspaceRoot`; fetch treats private-range/localhost as escalated; tool outputs enter the log with `taint: "tool_output"`.
- **Command construction (R15):** run_command takes argv arrays ONLY in M1b (no shell strings); child env is scrubbed of `ANTHROPIC_API_KEY`, `RAZIEL_COMPAT_KEY`, and `*_TOKEN`/`*_KEY`/`*_SECRET`-shaped vars.
- **Standing rules are config (R12):** `~/.raziel/rules.json` (under RAZIEL_HOME), schema-validated on load, narrow keys (tool + normalized pattern), never tool-wide for run_command; invalid file → no rules + one warning (fail closed).
- All user-visible strings pass through `sanitizeForTerminal` (existing src/term.ts); approval cards additionally escape newlines/CR byte-exact and show resolved paths (R11).
- Deferred OUT of M1b, tracked for M1c: text parsers hermes-json/qwen-xml (R9/R17 text half), MCP client, user-editable profiles + baseUrl hygiene (R1–R5; registry stays frozen code, RAZIEL_COMPAT_KEY still binds only to the hardcoded registry host), R14's batch-identical-reads UX (deny-timers land now, batching later).
- R6 (CI frozen-lockfile) lands in Task 8 as `.github/workflows/ci.yml`.

## File Structure

```
src/provider.ts        (amend once, Task 1)      src/tools/types.ts      (Task 2)
src/events.ts          (amend, Task 2)           src/tools/workspace.ts  (Task 3)
src/book.ts            (amend, Task 2)           src/tools/files.ts      (Task 3)
src/tools/search.ts    (Task 3)                  src/tools/exec.ts       (Task 4)
src/tools/fetch.ts     (Task 4)                  src/risk.ts             (Task 5)
src/approvals.ts       (Task 5)                  src/rules.ts            (Task 5)
src/engine.ts          (amend, Task 6)           src/providers/anthropic.ts (amend, Task 7)
src/providers/fake.ts  (amend, Task 1)           src/cli.ts + src/commands.ts (amend, Task 8)
.github/workflows/ci.yml (Task 8)
```

---

### Task 1: Provider contract v2 — the structured tool channel

**Files:**
- Modify: `src/provider.ts`
- Modify: `src/providers/fake.ts`
- Test: `tests/provider-contract.test.ts` (new)

**Interfaces:**
- Produces: `StreamChunk` gains `{ type: "tool_call"; id: string; name: string; args: unknown }`; `stream` opts gain `tools?: ToolSpec[]` where `ToolSpec = { name: string; description: string; inputSchema: object }` (exported from provider.ts). `FakeProvider` gains `scriptTool(name, args)` so tests can script a tool_call turn, and continues logging opts (now including `tools`).
- Consumes: nothing new.

- [ ] **Step 1: Write the failing test**

```ts
// tests/provider-contract.test.ts
import { describe, expect, test } from "bun:test";
import { FakeProvider } from "../src/providers/fake";
import type { StreamChunk, ToolSpec } from "../src/provider";

describe("provider contract v2", () => {
  test("FakeProvider can script a tool_call chunk and logs tools opt", async () => {
    const p = new FakeProvider();
    p.scriptTool("read_file", { path: "a.txt" });
    const tools: ToolSpec[] = [{ name: "read_file", description: "read", inputSchema: { type: "object" } }];
    const chunks: StreamChunk[] = [];
    for await (const c of p.stream({ model: "fake", messages: [{ role: "user", content: "hi" }], tools })) {
      chunks.push(c);
    }
    const call = chunks.find((c) => c.type === "tool_call");
    expect(call && call.type === "tool_call" ? call.name : null).toBe("read_file");
    expect(call && call.type === "tool_call" ? call.args : null).toEqual({ path: "a.txt" });
    expect(typeof (call && call.type === "tool_call" ? call.id : 0)).toBe("string");
    expect(p.optsLog[0]?.tools).toEqual(tools);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`scriptTool` not a function / `ToolSpec` not exported).
- [ ] **Step 3: Implement.** In `src/provider.ts` add and export:

```ts
export type ToolSpec = { name: string; description: string; inputSchema: object };

export type StreamChunk =
  | { type: "delta"; text: string }
  | { type: "tool_call"; id: string; name: string; args: unknown }
  | { type: "done"; stopReason: "end" | "error" };
```

and add `tools?: ToolSpec[];` to the `stream` opts object. In `fake.ts`, add a `private toolScript: { name: string; args: unknown }[] = []`, a `scriptTool(name: string, args: unknown): void` that pushes, extend `optsLog` entries with `tools`, and in `stream()` yield each scripted tool_call (`id: crypto.randomUUID()`) after any scripted deltas, before `done`. Existing behavior unchanged when nothing is scripted.

- [ ] **Step 4: `bun run typecheck` (0 errors) — note it may surface exhaustiveness gaps in engine.ts/providers on the new variant; fix ONLY by ignoring unknown chunk types where a `default`/fallthrough already exists (the engine's tool handling is Task 6, not here). All 97 existing tests must still pass.**
- [ ] **Step 5: Commit** `feat: provider contract v2 — structured tool-call channel (frozen after this commit)`

---

### Task 2: Events schema v2 + replay validation + book rendering

**Files:**
- Create: `src/tools/types.ts`
- Modify: `src/events.ts`, `src/book.ts`
- Test: `tests/events.test.ts` (extend), `tests/book.test.ts` (extend)

**Interfaces:**
- Produces (in `src/tools/types.ts`):

```ts
export type RiskClass = "low" | "medium" | "high" | "critical";
export type Provenance = "provider_structured"; // text parsers are M1c; no other value exists
export function canonicalJson(v: unknown): string; // stable key-sorted JSON
export function argsHash(tool: string, args: unknown): string; // sha256 hex of canonicalJson({tool, args})
```

- Produces (events.ts changes): `tool_request` gains `requestId: string; provenance: Provenance; argsHash: string`; `approval_request` gains `tool: string; argsHash: string; risk: RiskClass`; `tool_result` gains `requestId: string; taint: "tool_output"`; FIELD_CHECKS updated to match exactly (new strings via `str`, risk via `oneOf("low","medium","high","critical")`, provenance via `oneOf("provider_structured")`, taint via `oneOf("tool_output")`).
- Produces (book.ts): tool events render one sanitized line each instead of being skipped: `⚙ tool_request read_file <argsHash8>` / `? approval_request read_file [medium]` / `→ approval_decision allow` / `✓ tool_result read_file ok` (✗ when `ok: false`). Hash shown truncated to 8 chars.

- [ ] **Step 1: Failing tests.** In `tests/events.test.ts` add:

```ts
test("canonicalJson is key-order stable and argsHash matches recomputation", () => {
  expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  expect(argsHash("t", { b: 1, a: 2 })).toBe(argsHash("t", { a: 2, b: 1 }));
  expect(argsHash("t", { a: 1 })).not.toBe(argsHash("u", { a: 1 }));
});

test("v2 tool events validate; forged/missing fields rejected", () => {
  const ok = mkEvent("tool_request", { turn: "t", tool: "read_file", args: { p: 1 }, requestId: "r1", provenance: "provider_structured", argsHash: "ab".repeat(32) });
  expect(isValidEvent(JSON.parse(JSON.stringify(ok)))).toBe(true);
  const forged = { ...JSON.parse(JSON.stringify(ok)), provenance: "text_parsed" };
  expect(isValidEvent(forged)).toBe(false);
  const noHash = { ...JSON.parse(JSON.stringify(ok)) }; delete (noHash as any).argsHash;
  expect(isValidEvent(noHash)).toBe(false);
});
```

In `tests/book.test.ts` add a fixture session containing one of each tool event and assert each renders a line containing the tool name and (for approval_request) the risk class, and that an OSC/control-char payload inside `tool` is sanitized out of the render.

- [ ] **Step 2: Run — expect FAIL** (module missing, mkEvent field errors).
- [ ] **Step 3: Implement** `src/tools/types.ts`:

```ts
import { createHash } from "node:crypto";

export type RiskClass = "low" | "medium" | "high" | "critical";
export type Provenance = "provider_structured";

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const rec = v as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`).join(",")}}`;
}

export function argsHash(tool: string, args: unknown): string {
  return createHash("sha256").update(canonicalJson({ tool, args })).digest("hex");
}
```

Then extend events.ts union + FIELD_CHECKS exactly as the Interfaces block states, and book.ts rendering (every rendered fragment through `sanitizeForTerminal`).

- [ ] **Step 4: typecheck + full suite green.** Existing engine.ts mkEvent call sites don't construct tool events yet, so no ripple expected; if typecheck flags any, fix the call site to the new shape.
- [ ] **Step 5: Commit** `feat: events v2 — provenance, argsHash, risk on tool events; book renders them`

---

### Task 3: Workspace containment + file tools (read/write/edit/grep/glob)

**Files:**
- Create: `src/tools/workspace.ts`, `src/tools/files.ts`, `src/tools/search.ts`
- Test: `tests/tools-files.test.ts` (new)

**Interfaces:**
- Produces (`workspace.ts`):

```ts
export class Workspace {
  constructor(root: string) {} // stores resolve(root)
  readonly root: string;
  /** resolve() the candidate against root; throw Error("path escapes workspace: <resolved>") unless resolved === root or resolved startsWith root + sep. Rejects absolute paths outside root and any traversal. */
  contain(p: string): string;
}
```

- Produces (`files.ts` / `search.ts`): a common tool shape used by every builtin —

```ts
export type BuiltinTool = {
  spec: ToolSpec;                       // name, description, JSON inputSchema
  run(args: unknown, ws: Workspace): Promise<{ ok: boolean; output: string }>;
};
export const readFileTool: BuiltinTool;   // args {path, offset?, limit?} — output capped at 64_000 chars with "…[truncated]" marker
export const writeFileTool: BuiltinTool;  // args {path, content} — refuses to overwrite unless {overwrite: true}
export const editFileTool: BuiltinTool;   // args {path, old, new} — old must match exactly once, else ok:false with count
export const grepTool: BuiltinTool;       // args {pattern, path?} — literal-safe: new RegExp with try/catch → ok:false on invalid pattern
export const globTool: BuiltinTool;       // args {pattern} — Bun.Glob scan within ws.root
```

Every `run` validates args shape itself (typeof checks — no deps), calls `ws.contain()` on every path, catches all errors into `{ ok: false, output: message }` — **tools never throw**.

- [ ] **Step 1: Failing tests (write them all, run once, capture RED):** containment — `contain("../x")`, `contain("/etc/passwd")`, `contain("a/../../x")` all throw with the resolved path in the message; `contain("sub/f.txt")` returns the resolved path. Prefix-boundary case: root `/tmp/ws` must NOT contain `/tmp/wsx/f` (test via two mkdtemp dirs named with a shared prefix). File tools — write/read/edit roundtrip in a mkdtemp workspace; write without overwrite on existing file → ok:false; edit with 0 and 2 matches → ok:false; read output cap: write 70_000 chars, read returns ≤ 64_020 chars ending in the truncation marker; grep invalid regex `"("` → ok:false not throw; glob finds the file it made; every tool with a path outside root → ok:false mentioning "escapes".
- [ ] **Step 2: RED run, capture output.**
- [ ] **Step 3: Implement.** `contain`: `const r = resolve(this.root, p); if (r !== this.root && !r.startsWith(this.root + sep)) throw new Error(\`path escapes workspace: ${r}\`); return r;` (import `resolve`, `sep` from `node:path`; note `resolve(root, absolutePath)` yields the absolute path, so the check covers absolutes too). File ops via `Bun.file`/`Bun.write`; grep reads the contained file (or walks root when path omitted, capped at 200 files) line-by-line.
- [ ] **Step 4: typecheck + suite green.** **Step 5: Commit** `feat: workspace containment + file/search builtins — tools never throw`

---

### Task 4: run_command (argv, scrubbed env) + fetch (URL classing, taint)

**Files:**
- Create: `src/tools/exec.ts`, `src/tools/fetch.ts`
- Test: `tests/tools-exec-fetch.test.ts` (new)

**Interfaces:**
- Produces:

```ts
// exec.ts
export function scrubEnv(env: Record<string, string | undefined>): Record<string, string>;
// drops ANTHROPIC_API_KEY, RAZIEL_COMPAT_KEY, and any var whose NAME matches /(_KEY|_TOKEN|_SECRET|_PASSWORD)$/i or /^(AWS|GH|GITHUB|OPENAI|NPM)_/i; keeps the rest (PATH, HOME, …)
export const runCommandTool: BuiltinTool; // args {argv: string[], cwd?: string} — argv ONLY (R15); cwd contained via ws.contain; Bun.spawn with scrubbed env, 30s timeout kill, stdout+stderr captured, capped at 64_000 chars; output prefixed "exit <code>\n"
// fetch.ts
export function classifyUrl(u: string): "public" | "private" | "invalid";
// private: localhost, *.localhost, 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, ::1, fc00::/7, fe80::/10, 0.0.0.0 — matched on the URL hostname (literal IPs parsed; named hosts other than localhost are "public" — DNS-rebinding is out of scope this milestone and noted in the report)
export const fetchTool: BuiltinTool; // args {url} — http/https only; redirect: "manual", follow max 3 SAME-ORIGIN redirects, cross-origin redirect → ok:false; response body text capped 64_000; output ALWAYS prefixed "[UNTRUSTED FETCHED CONTENT]\n" (taint marking, R16)
```

- [ ] **Step 1: Failing tests:** scrubEnv drops `ANTHROPIC_API_KEY`, `MY_APP_TOKEN`, `AWS_ANYTHING`, keeps `PATH`/`LANG`. runCommandTool: `{argv: ["/bin/echo", "hi"]}` → ok:true, output contains "exit 0" and "hi"; `{argv: ["/usr/bin/env"]}` with `ANTHROPIC_API_KEY=test-secret` set in the test (save/restore) → output does NOT contain "test-secret"; string instead of array → ok:false; nonexistent binary → ok:false not throw. classifyUrl: `http://localhost:8080/x`→private, `http://127.0.0.1/`→private, `http://192.168.1.5/`→private, `http://10.0.0.1/`→private, `https://example.com/`→public, `ftp://x/`→invalid, `not a url`→invalid. fetchTool against a local `Bun.serve` fixture: 200 text → ok:true with the `[UNTRUSTED FETCHED CONTENT]` prefix; a redirect to `http://127.0.0.1:1/` (different origin) → ok:false mentioning redirect.
- [ ] **Step 2: RED.** **Step 3: Implement** per the interface block (IPv4 private check by parsing octets, not string prefix — `172.20.x` must hit the 172.16/12 range).
- [ ] **Step 4: typecheck + suite.** **Step 5: Commit** `feat: run_command (argv-only, scrubbed env) + fetch (url classing, taint prefix)`

---

### Task 5: Risk engine + approval manager + standing rules

**Files:**
- Create: `src/risk.ts`, `src/rules.ts`, `src/approvals.ts`
- Test: `tests/risk.test.ts`, `tests/approvals.test.ts` (new)

**Interfaces:**
- Produces (`risk.ts`):

```ts
export function riskClassFor(tool: string, args: unknown, ws: Workspace): RiskClass;
// read_file/grep/glob with contained path → "low"; contain() throws → "critical"
// write_file/edit_file contained → "medium"
// fetch public → "medium"; fetch private/invalid → "high"
// run_command → "high" always in M1b
// unknown tool name or malformed args (non-object) → "critical"   (R13 fail-closed)
```

- Produces (`rules.ts`):

```ts
export type StandingRule = { tool: string; pattern: string }; // pattern matches canonicalJson(args) via simple glob (* wildcard only)
export class Rules {
  static load(path: string): Rules; // missing file → empty; invalid JSON/schema → empty + warning string retrievable via .loadWarning
  matches(tool: string, args: unknown): boolean;
  add(rule: StandingRule): void;    // REFUSES { tool: "run_command", pattern: "*" } and any pattern === "*" for high-risk tools (throws) — R12 narrow keys
  save(path: string): void;         // atomic: write tmp + rename
  count(): number;
  list(): StandingRule[];
}
```

- Produces (`approvals.ts`):

```ts
export type ApprovalDeps = { ask(card: string, risk: RiskClass): Promise<"allow" | "deny" | "always"> };
export class ApprovalManager {
  constructor(rules: Rules, deps: ApprovalDeps, rulesPath: string) {}
  /** Returns the decision AND the argsHash it bound to. Order: risk==="critical" → always deny (no prompt). rules.matches → allow (only for low/medium — standing rules NEVER auto-allow high/critical). Else deps.ask() with a card built by buildCard(). "always" → rules.add + save, then allow. */
  decide(tool: string, args: unknown, risk: RiskClass, ws: Workspace): Promise<{ decision: "allow" | "deny"; argsHash: string }>;
}
export function buildCard(tool: string, args: unknown, risk: RiskClass, ws: Workspace): string;
// sanitizeForTerminal over the whole card; args rendered as canonicalJson with \n and \r shown as literal \\n \\r (byte-exact, R11); any `path` arg additionally shown resolved via ws.contain (or "ESCAPES WORKSPACE" when contain throws); includes risk class and argsHash first 8
```

- [ ] **Step 1: Failing tests:** riskClassFor table (one assertion per row above, including a `../` path → critical and unknown tool → critical). Rules: load missing → count 0; load garbage JSON → count 0 + loadWarning set; add `{tool:"run_command",pattern:"*"}` throws; roundtrip add/save/load/matches with pattern `*"path":"notes/*` style glob. ApprovalManager: critical → deny without calling ask (spy); standing rule match on low → allow without ask; standing rule match on HIGH → still asks; ask→"always" persists a rule (file exists after) and returns allow; returned argsHash equals `argsHash(tool, args)`. buildCard: embeds `\r` in an arg → card contains literal backslash-r and no raw CR byte; card contains resolved path for a `path` arg.
- [ ] **Step 2: RED.** **Step 3: Implement.** Glob match: escape regex chars except `*` → `.*`.
- [ ] **Step 4: typecheck + suite.** **Step 5: Commit** `feat: computed risk classes, hash-bound approval manager, standing rules config`

---

### Task 6: Engine tool loop

**Files:**
- Modify: `src/engine.ts` (this will exceed 200 lines — split the tool-loop into `src/engine_tools.ts` as part of this task)
- Create: `src/engine_tools.ts`, `src/tools/registry.ts`
- Test: `tests/engine-tools.test.ts` (new)

**Interfaces:**
- Produces (`src/tools/registry.ts`):

```ts
export function builtinTools(): Map<string, BuiltinTool>; // read_file, write_file, edit_file, grep, glob, run_command, fetch — capped by profile.maxToolSurface when wired (slice insertion order)
export function toolSpecs(tools: Map<string, BuiltinTool>): ToolSpec[];
```

- Produces (engine): `EngineOpts` gains `tools?: { registry: Map<string, BuiltinTool>; ws: Workspace; approvals: ApprovalManager }` (all-or-nothing object; absent → M1a behavior byte-identical). `context()` additionally replays tool_result events as user-role messages formatted `[tool_result <tool>] <output>` so resumed sessions keep tool context.
- Behavior (the loop, in `engine_tools.ts` as `runToolTurn(...)` called from `send`):
  1. Stream with `tools: toolSpecs(registry)`. Collect `tool_call` chunks; deltas stream as today.
  2. On stream end with ≥1 tool_call: for EACH call in order — append+yield `tool_request` (requestId = chunk id, provenance "provider_structured", argsHash computed); compute `risk = riskClassFor(...)`; append+yield `approval_request` (requestId, tool, argsHash, risk); `decide(...)` → append+yield `approval_decision`; if deny → `tool_result` `{ok:false, output:"denied by user"}`; if allow → **recompute argsHash from the args about to execute and refuse (ok:false, output:"argsHash mismatch — refusing"; do not run) unless it equals the decision's hash (R10)**; run the tool (unknown name → ok:false "unknown tool"); append+yield `tool_result` (requestId, taint "tool_output", output through sanitizeForTerminal before persist).
  3. Re-stream with updated context. Max **8** tool rounds per turn; on exhaustion append error event "tool round limit" and finish("end").
  4. Abort signal checked between every step; engine still never throws.
- [ ] **Step 1: Failing tests (FakeProvider-driven):** scripted tool_call for read_file on a real mkdtemp workspace file, auto-allow ApprovalDeps → event sequence in the store is exactly user_message, tool_request, approval_request, approval_decision, tool_result, assistant_message, turn_end — and the tool_result output contains the file content; deny path → tool never runs (spy on registry via a wrapper tool) and tool_result says denied; unknown tool scripted → ok:false result, no throw; a provider that yields tool_calls forever → stops at 8 rounds with the limit error event; hash-mismatch guard: monkeypatch a wrapper that mutates args between decide and execute → refused with "argsHash mismatch"; `tools` absent → M1a snapshot test still passes unchanged (run existing engine tests).
- [ ] **Step 2: RED.** **Step 3: Implement** per the behavior spec. Keep `engine.ts` ≤ 200 by delegating; `send` signature unchanged.
- [ ] **Step 4: typecheck + FULL suite (all M1a engine tests must pass untouched).** **Step 5: Commit** `feat: engine tool loop — provenance-tagged, hash-bound, bounded rounds`

---

### Task 7: Anthropic structured tool channel

**Files:**
- Modify: `src/providers/anthropic.ts`
- Test: `tests/anthropic-provider.test.ts` (extend)

**Interfaces:**
- Consumes: `ToolSpec[]` from opts. Maps to SDK `tools: [{ name, description, input_schema }]`. Emits `tool_call` chunks from `content_block_start` (type `tool_use`: capture id+name) + accumulated `input_json_delta` partial_json, yielding ONE tool_call per block at `content_block_stop` with `args = JSON.parse(accumulated)` — a JSON parse failure yields NO tool_call and instead a thrown Error (the engine's catch path handles it; a garbled tool call must fail closed, R13, never be "recovered", R17).
- [ ] **Step 1: Failing test:** using the existing fetch-fake/mock pattern from the current anthropic tests, script an SSE stream containing a `tool_use` block (`content_block_start` with id `tu_1`, name `read_file`; two `input_json_delta`s splitting `{"path":"a.txt"}` mid-token; `content_block_stop`) and assert exactly one `tool_call` chunk `{id:"tu_1", name:"read_file", args:{path:"a.txt"}}`; and that a stream whose partial_json accumulates to invalid JSON produces a thrown error, not a tool_call. Assert the request body contained the mapped `tools` array.
- [ ] **Step 2: RED.** **Step 3: Implement.** **Step 4: typecheck + suite.** **Step 5: Commit** `feat: anthropic native tool channel — garbled tool JSON fails closed`

---

### Task 8: CLI wiring, /approve, deny-default timer, CI

**Files:**
- Modify: `src/cli.ts`, `src/commands.ts`
- Create: `.github/workflows/ci.yml`
- Test: `tests/cli.test.ts` (extend)

**Interfaces:**
- `main()` builds `Workspace(process.cwd())`, `Rules.load(join(razielHome(), "rules.json"))` (print loadWarning if set), `ApprovalManager` whose `ask` renders the card via `deps.write` and reads one line: `y`=allow, `a`=always, anything else=deny; **high-risk asks additionally start a 30s timer that resolves "deny" if no answer (R14 deny-by-default; injectable timeout for tests, `setTimeout` ref unref'd)**; passes `tools` into the Engine (and into every `/model`-swapped engine — thread through `createModelCommand`'s engine rebuild).
- `/approve` command in `createModelCommand`'s command map style: bare → numbered list of standing rules + count (session-visible counter, R14); `/approve rm <n>` → remove + save.
- `ci.yml`: on push/PR — `oven-sh/setup-bun@v2`, `bun install --frozen-lockfile`, `bun run typecheck`, `bun test` (R6).
- [ ] **Step 1: Failing tests:** scripted-IO repl test (existing pattern): fake provider scripts a tool_call; input "y" → transcript shows the approval card (contains tool name + risk) then the tool result; input "x" → denied; input "a" → a rules.json appears under the test RAZIEL_HOME and a second identical call does not re-ask; `/approve` lists it; high-risk ask with injected 10ms timer and no input → denied. Engine rebuild via `/model` keeps tools working (swap then script another tool_call).
- [ ] **Step 2: RED.** **Step 3: Implement.** **Step 4: typecheck + full suite + `wc -l src/*.ts src/tools/*.ts` all < 200.** **Step 5: Commit** `feat: approval UX with deny-default timer, /approve rules, CI frozen-lockfile gate`

---

## Self-Review Notes (author, at write time)

- R7/R8 (dependency vetting/no-sandbox) are satisfied by adding zero new deps this milestone; pi-ai's auth-path read stays a standing M1c gate before profiles go user-editable.
- The R14 "batch identical low-risk reads" half is explicitly deferred (Global Constraints) — deny-timers and the rules counter land now.
- Type consistency checked: `BuiltinTool.run(args, ws)` is uniform across Tasks 3/4/6; `ToolSpec` defined once (Task 1) and imported everywhere; `RiskClass`/`Provenance` defined once (Task 2).
- Spec coverage: SPEC §6 built-ins v1 all present (read/write/edit, run, grep/glob, fetch); MCP client explicitly M1c (SPEC lists it under Tools but M1 proof only needs builtins+approvals; noted as a deviation the milestone doc sanctions).
