# Raziel adversarial security review — 2026-09-01

Scope: /Users/dtd/raziel @ 866ea67 (+ untracked src/providers/ollama.ts, tests/ollama-provider.test.ts).
Method: full source read; live probes with `RAZIEL_FAKE=1` and a scratch `RAZIEL_HOME` under the session
scratchpad (never ~/.raziel); no tracked files modified; no network. `bun test`: 42 pass / 0 fail.

Threat models: (1) malicious model output, (2) malicious/compromised session input, (3) design review of
the coming M1b tool system.

---

## Findings

### F1 — HIGH — Path traversal in session id → arbitrary read/write outside RAZIEL_HOME — PROVEN
**Attack story.** `--session` and `book <id>` feed an unvalidated id straight into
`join(sessionsDir(), `${id}.jsonl`)`, so `../../x` escapes RAZIEL_HOME entirely: a wrapper script,
shell alias, automation, or (soon) an ACP client that passes an attacker-influenced session id makes
raziel append attacker/model-controlled JSON lines to any writable path ending `.jsonl`, and `book`
renders any such file's contents to the terminal.
**Where.** /Users/dtd/raziel/src/session.ts:21-22 (`this.id = sessionId ?? …; this.path = join(sessionsDir(), `${this.id}.jsonl`)`);
callers /Users/dtd/raziel/src/cli.ts:52 (`book`), :56 (`--session`).
**Proof.**
- Write: `printf 'hello\n/quit\n' | RAZIEL_FAKE=1 RAZIEL_HOME=$H bun run src/cli.ts --session '../../escape-probe'`
  created `…/scratchpad/probe/escape-probe.jsonl` **outside** `$H` (two levels above sessions/).
- Read: planted `…/probe/planted.jsonl` outside `$H`; `book '../../planted'` printed its content
  ("PLANTED-OUTSIDE-HOME" / "secret body").
**Severity note.** High today (attacker must influence argv); becomes Critical the moment session ids
arrive over ACP/web-panel (SPEC §2: "ACP is the only door") or ids are derived from untrusted data.
**Minimal fix.** Validate id at the SessionStore boundary: `/^[A-Za-z0-9][A-Za-z0-9._-]*$/` (reject
`/`, `\`, `..`, leading dot), then belt-and-braces `resolve(path).startsWith(resolve(sessionsDir()) + sep)`.

### F2 — HIGH — ANSI/OSC escape injection: model output reaches the terminal raw — PROVEN
**Attack story.** A hostile or prompt-injected model streams `ESC ]0;…BEL` (title), `ESC ]52;c;<b64>BEL`
(OSC 52 clipboard write — lands attacker text in the user's clipboard on iTerm2/kitty/xterm-class
terminals → classic paste-to-shell), `ESC[8m` conceal, `ESC[2J` clear, cursor-move overwrites — all
delivered verbatim both live and on every later `book` replay. This is the exact class that becomes an
approval-bypass in M1b (display `ls`, approve `curl|sh`).
**Where.** Live stream: /Users/dtd/raziel/src/cli.ts:36 (`opts.write(e.text)` raw). Replay:
/Users/dtd/raziel/src/book.ts:71 (user text), :73/76/78 (body), :93-94 (listSessions preview — `truncate()`
collapses only `\s+`, ESC/BEL pass through; session *filenames* are also printed raw). Error text path too
(cli.ts:38, book.ts:78 — provider-controlled, see F6).
**Proof.** Drove hostile deltas through FakeProvider via a scratchpad script into a scratch RAZIEL_HOME;
`bun run src/cli.ts book hostile | od -c` shows raw `033 ] 0 ; P W N E D - T I T L E \a`,
`033 ] 5 2 ; c ; …`, `033 [ 8 m`, `033 [ 2 J` on stdout; same for the user-message echo and the
listSessions preview line.
**Minimal fix.** One sanitizer at every text→terminal boundary (cli write of deltas, book render, previews):
strip C0 except `\n\t`, strip `\x1b` + C1 (i.e., kill all ESC/CSI/OSC/DCS from *content*), keeping raziel's
own `paint()` codes which are added after sanitization. Apply to user, assistant, and error text alike.

### F3 — MEDIUM — JSONL integrity: write path PROVEN robust; replay trusts unvalidated `type` — residual THEORIZED
**Attack story (residual).** `replay()` does `JSON.parse(line) as SessionEvent` with no schema check, so
any file the store can be pointed at (F1 traversal, sync'd/tampered session dirs) forges arbitrary events
— including future `approval_decision: "always"` and `tool_result` records — that engine context and book
render will trust verbatim.
**Where.** /Users/dtd/raziel/src/session.ts:34.
**Proof of the good news (write side).** Hostile deltas containing a raw `\n` + a complete forged JSON
event line, plus U+2028/U+2029, were streamed through FakeProvider: the session file held exactly 3 lines,
per-line types `[user_message, assistant_message, turn_end]`, forged event **not** parseable as a
standalone line — `JSON.stringify` escaping holds and the per-line parse (torn lines skipped) is robust.
Model text cannot break the log format. PROVEN.
**Minimal fix.** A small runtime validator on replay (known `type`, required fields, string fields are
strings); skip-with-count anything else. Never let replayed events seed security state (see F9c).

### F4 — MEDIUM — Crafted session file = persistent prompt injection into model context — THEORIZED (mechanism proven by F1+code)
**Attack story.** `Engine.context()` rebuilds provider messages from replayed `user_message`/
`assistant_message` events, so anyone who can write a session file (F1, SyncThing'd dirs, backup restore)
injects assistant-role turns the model believes it said — a durable jailbreak that re-arms on every
`--session` resume, and the laundering seed for M1b tool calls.
**Where.** /Users/dtd/raziel/src/engine.ts:28-35.
**Minimal fix.** Can't fully fix (resume is the feature) — but: fix F1, validate on replay (F3), and in
M1b mark context reconstructed from disk as replay-provenance so tool-affecting instructions inside it are
never auto-trusted (taint bit, SPEC lane 2 — pull it forward from v1.5).

### F5 — LOW — Absolute-path `--session` doesn't escape but silently kills persistence — PROVEN
**Attack story.** `join()` treats an absolute id as relative (`$HOME/sessions/private/tmp/….jsonl`), the
parent dirs don't exist, `appendFileSync` throws ENOENT, and every turn short-circuits to an error event
that also can't persist — the REPL keeps running with no model call and no log.
**Where.** /Users/dtd/raziel/src/session.ts:22,26; swallow at /Users/dtd/raziel/src/engine.ts:37-43,50-58.
**Proof.** `--session "$S/probe/absprobe"` → banner prints the raw id, then
`[error] ENOENT … /home/sessions/private/tmp/…/absprobe.jsonl`; nothing written anywhere.
**Minimal fix.** Same id validation as F1 (reject at startup with a clear message, exit non-zero).

### F6 — LOW — Provider/server-controlled bytes persisted and echoed via error events — THEORIZED (code-proven path)
**Attack story.** Ollama error paths embed the full HTTP response body and raw malformed NDJSON lines in
`Error.message`; the engine appends that to the session JSONL and the CLI prints it raw — an
attacker-controlled *server* (or SSRF target once baseUrl is configurable, F7) gets a byte channel into
the terminal (F2) and the durable log.
**Where.** /Users/dtd/raziel/src/providers/ollama.ts:44 (`throw new Error(\`ollama /api/chat ${res.status}: ${body}\`)`),
:69 (malformed line echoed); persisted at /Users/dtd/raziel/src/engine.ts:88, printed at cli.ts:38.
Key handling itself is clean today: `ANTHROPIC_API_KEY` is read from env only (anthropic.ts:9, cli.ts:63)
and never written to session files (checked: no env values in any event constructor); `RAZIEL_FAKE` is a
strict `=== "1"` check. Anthropic SDK error messages are believed to redact auth headers — THEORIZED, worth
a pin-test when the compat provider lands (`RAZIEL_COMPAT_KEY` must get the same never-in-events guarantee).
**Minimal fix.** Truncate (e.g. 512 bytes) + F2-sanitize provider error text at event-creation time.

### F7 — DESIGN-NOTE — baseUrl / SSRF shape for the coming user-editable profiles
Today the registry is hardcoded (/Users/dtd/raziel/src/profiles.ts:18-25 — `127.0.0.1:11434` only) and
OllamaProvider accepts any injected `baseUrl` (ollama.ts:15) — safe as long as only code sets it. The M1a
plan adds `OpenAICompatProvider({ baseUrl, apiKey })` and later milestones make profiles user-editable
config. Requirements to carry into that design: (a) scheme allowlist http/https only; (b) first-use
confirmation surfacing the exact host for any non-loopback baseUrl; (c) **key↔host binding** — a provider
API key (ANTHROPIC_API_KEY, RAZIEL_COMPAT_KEY) may only ever be attached to the host it was configured
with, and editing baseUrl must drop the key pairing (else a tampered profile exfiltrates the key to an
attacker host with one request); (d) responses from these endpoints are untrusted bytes (F6 sanitization);
(e) no redirect-following into other hosts with auth headers attached.

### F8 — DESIGN-NOTE — Dependency / supply-chain posture
Current tree is admirably small: runtime dep is only `@anthropic-ai/sdk` (caret `^0.122.0` in
package.json, but bun.lock pins 0.122.0 with sha512 — good; transitives: json-schema-to-ts,
standardwebhooks, @stablelib/base64, fast-sha256, @babel/runtime). No install scripts of note. Gaps:
(a) CI should install with `bun install --frozen-lockfile` so the caret can never float silently;
(b) the M1a plan (docs/superpowers/plans/2026-09-02-raziel-m1a-core.md, Task on OpenAICompatProvider)
brings in `@earendil-works/pi-ai` via deep subpath imports "bypassing the auth-manager" — that is a large
multi-provider client with its own credential-handling code; pin exact, read its auth/redirect/env
handling before trusting it with keys, and prefer the narrowest subpath import; (c) `bin.raziel` executes
src/cli.ts directly under bun — fine, but means a compromised dep runs with full user privileges at REPL
start (no sandbox), which raises the bar for (b).

### F9 — DESIGN-NOTE (pre-build requirement set) — M1b tool system hardening
The seams already exist (events.ts:8-11 `tool_request`/`approval_request`/`approval_decision`/`tool_result`;
SPEC §3.2-3.4, §6; book.ts:58 currently skips them in render). These properties must be in the M1b design
before code exists:

1. **Tool-call provenance / laundering.** `tool_request` events may be constructed only from the
   provider's structured tool-call channel. For text-parsed local models (profiles.ts `ParserKind`
   "hermes-json" | "qwen-xml"), the parser must run ONLY over the assistant's own turn text — never over
   `tool_result` content, fetched documents, or user pastes. Otherwise a webpage containing Qwen XML tool
   syntax becomes a tool call (classic laundering). Tag every event with provenance/taint (SPEC lane 2
   promises "taint propagated into the event log" — needed in M1b, not v1.5).
2. **Approval binds to args, not ids.** `approval_decision.requestId` must commit to a hash of the exact
   tool+args being approved; the executor must refuse if the args it's about to run don't hash-match what
   was displayed. No TOCTOU window where the model amends args after approval.
3. **Approval display integrity.** The approval card is rendered by the engine from its own structured
   copy of the args, passed through the F2 sanitizer, with explicit escaping of newlines/CR and byte-exact
   display of command strings. F2 unfixed makes every approval spoofable (conceal/CR-overwrite the real
   command). Show full paths post-resolution, not as given.
4. **Standing rules ("always") are config, not replay.** Rules live in their own schema-validated,
   user-visible, revocable file (`/approve` per SPEC §4) — never reconstructed from session-log
   `approval_decision` events (F1/F3: a planted session file must not be able to seed an "always" rule).
   Rule keys must be narrow: tool + normalized argument pattern, never tool-wide "always allow run_command".
5. **Risk class computed, not declared.** The approval ladder reads a risk class the *executor* derives
   from concrete args at decision time (write inside workspace vs outside; command allowlist; URL target
   class). The model or the tool manifest must not be able to self-declare "low risk". Ambiguous parse or
   unknown tool → fail closed (SPEC's deny/garble/hang→one-fail-closed shape belongs to the direct
   executor too, not just the walled one).
6. **Approval-fatigue design.** ask-everything must not train reflexive `y`: batch identical low-risk
   reads, but never coalesce across risk classes; deny-by-default timers rather than approve-on-enter for
   risky classes; a session-visible counter of what "always" rules exist.
7. **Command construction.** run-command takes argv arrays where possible; if a shell string, display
   exact bytes and run with a scrubbed child environment — strip ANTHROPIC_API_KEY / RAZIEL_COMPAT_KEY /
   token-shaped vars by default (otherwise key exfil is one approved `env | curl` away).
8. **File tools: containment.** read/write/edit must `resolve()` + prefix-check against a declared
   workspace root — F1 shows the current join-without-validation habit; the identical bug in write_file is
   prompt-injection-to-arbitrary-write. Fetch tool: private-range/localhost targets escalate risk class;
   fetched bytes enter context taint-marked.
9. **maxToolSurface / parser strictness** (profiles.ts:9) enforced per profile with no greedy fallback
   parser — a lenient recovery parser on qwen-xml is where laundering hides.

### F10 — INFORMATIONAL (clean) — Git history secret sweep — PROVEN CLEAN
`git log -p --all` grepped for key-shaped strings (sk-ant-*, sk-*, AKIA*, ghp_*, github_pat_*, xox[baprs]-,
BEGIN…PRIVATE KEY, AIza*): **no matches** in any commit. `.gitignore` covers `.env` and `*.local`. Public
repo posture OK on this axis today; re-run the sweep pre-push once real provider config lands.

### F11 — LOW — `SessionStore.list()` stat race crashes `book` — THEORIZED
readdir→statSync per file (/Users/dtd/raziel/src/session.ts:45) with no try/catch: a session file deleted
between the two calls (concurrent raziel, cleanup job) throws and takes down `book`/listSessions.
Availability nit. Fix: wrap statSync, skip missing.

---

## Notes for completeness
- Test hygiene is good: every fs-touching test mkdtemps its own RAZIEL_HOME (tests/*.ts beforeEach).
- REPL input is line-based, so interactive users can't inject raw multi-line/control input into
  user_message beyond what F2 covers; `arg()` (cli.ts:44-47) will happily take a following flag as the
  value (`--session --model`) — cosmetic.
- Engine `finish()` on error persists no partial assistant text (by design, commit 60abb63) — verified in
  code; curtailment ("interrupt with partial text") persists the partial, which is the right audit shape.
