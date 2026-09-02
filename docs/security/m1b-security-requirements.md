# M1b security requirements

Extracted from the design-note findings (F7, F8, F9) in
`docs/security/2026-09-02-adversarial-review-1.md` (the 2026-09-01 adversarial
security review). These are requirements the M1b design must satisfy before
any of the corresponding systems — user-editable provider profiles, new
dependencies, and the tool-call/approval system — ship. Substance is verbatim
from the review; numbering and formatting are cleaned up for planning use.

## Provider profiles / baseUrl (from F7)

Today the provider registry is hardcoded (127.0.0.1:11434 only) and
`OllamaProvider` accepts any injected `baseUrl` — safe only because just code
sets it today. M1b adds `OpenAICompatProvider({ baseUrl, apiKey })` and later
milestones make profiles user-editable config. Carry these requirements into
that design:

1. **Scheme allowlist.** Only `http` and `https` baseUrls are accepted.
2. **First-use confirmation.** Any non-loopback baseUrl must surface the exact
   host to the user for confirmation before first use.
3. **Key-host binding.** A provider API key (`ANTHROPIC_API_KEY`,
   `RAZIEL_COMPAT_KEY`) may only ever be attached to the host it was
   configured with. Editing `baseUrl` must drop the key pairing — otherwise a
   tampered profile exfiltrates the key to an attacker host with one request.
4. **Untrusted responses.** Responses from these endpoints are untrusted bytes
   and must go through terminal sanitization (see F6/F2 in the review) before
   display or persistence.
5. **No cross-host redirects with auth attached.** Requests must not follow
   redirects into other hosts while carrying auth headers.

## Dependency / supply-chain posture (from F8)

Current tree is small (`@anthropic-ai/sdk` is the only runtime dependency,
pinned in bun.lock with sha512). Gaps to close before M1b adds dependencies:

6. **Frozen installs in CI.** CI must install with `bun install
   --frozen-lockfile` so a caret range (e.g. `^0.122.0`) can never float
   silently.
7. **Vet new multi-provider clients before trusting them with keys.** The M1a
   plan brings in `@earendil-works/pi-ai` via deep subpath imports "bypassing
   the auth-manager." This is a large multi-provider client with its own
   credential-handling code. Pin an exact version, read its auth/redirect/env
   handling before trusting it with keys, and prefer the narrowest subpath
   import.
8. **No sandbox at REPL start.** `bin.raziel` executes `src/cli.ts` directly
   under bun with no sandbox, so a compromised dependency runs with full user
   privileges at REPL start. This raises the bar on requirement 7 — vet
   dependencies more carefully because there is no runtime containment
   backstop.

## Tool system hardening (from F9 — pre-build requirement set)

The seams already exist (`events.ts`: `tool_request` / `approval_request` /
`approval_decision` / `tool_result`; SPEC §3.2-3.4, §6; `book.ts` currently
skips these event types in render). These properties must be in the M1b
design before code exists:

9. **Tool-call provenance / laundering.** `tool_request` events may be
   constructed only from the provider's structured tool-call channel. For
   text-parsed local models (profiles.ts `ParserKind` `hermes-json` |
   `qwen-xml`), the parser must run ONLY over the assistant's own turn text —
   never over `tool_result` content, fetched documents, or user pastes.
   Otherwise a webpage containing Qwen XML tool syntax becomes a tool call
   (classic laundering). Tag every event with provenance/taint (SPEC lane 2
   promises "taint propagated into the event log" — this is needed in M1b,
   not deferred to v1.5).
10. **Approval binds to args, not ids.** `approval_decision.requestId` must
    commit to a hash of the exact tool+args being approved. The executor must
    refuse to run if the args it's about to execute don't hash-match what was
    displayed at approval time. No TOCTOU window where the model amends args
    after approval.
11. **Approval display integrity.** The approval card must be rendered by the
    engine from its own structured copy of the args, passed through the
    terminal sanitizer (F2), with explicit escaping of newlines/CR and
    byte-exact display of command strings. Without the F2 fix, every approval
    is spoofable (conceal/CR-overwrite the real command). Show full paths
    post-resolution, not as given.
12. **Standing rules ("always") are config, not replay.** Rules must live in
    their own schema-validated, user-visible, revocable file (`/approve` per
    SPEC §4) — never reconstructed from session-log `approval_decision`
    events. This closes the F1/F3 attack where a planted session file seeds
    an "always" rule. Rule keys must be narrow: tool + normalized argument
    pattern, never tool-wide (e.g. never "always allow run_command").
13. **Risk class computed, not declared.** The approval ladder must read a
    risk class the *executor* derives from concrete args at decision time
    (write inside workspace vs. outside; command allowlist; URL target
    class). The model or the tool manifest must not be able to self-declare
    "low risk." Ambiguous parse or unknown tool must fail closed (the SPEC's
    deny/garble/hang → one-fail-closed shape belongs to the direct executor
    too, not just the walled one).
14. **Approval-fatigue design.** Ask-everything must not train reflexive "y":
    batch identical low-risk reads, but never coalesce across risk classes;
    use deny-by-default timers rather than approve-on-enter for risky
    classes; keep a session-visible counter of what "always" rules exist.
15. **Command construction.** Run-command tools take argv arrays where
    possible; if a shell string is used, display exact bytes and run with a
    scrubbed child environment — strip `ANTHROPIC_API_KEY` /
    `RAZIEL_COMPAT_KEY` / token-shaped vars by default. Otherwise key exfil is
    one approved `env | curl` away.
16. **File tools: containment.** Read/write/edit tools must `resolve()` and
    prefix-check against a declared workspace root — the same join-without-
    validation habit fixed for session ids in F1 would otherwise reappear
    identically as prompt-injection-to-arbitrary-write in `write_file`. The
    fetch tool must treat private-range/localhost targets as an escalated
    risk class, and fetched bytes must enter context taint-marked.
17. **Parser strictness.** `maxToolSurface` / parser strictness
    (`profiles.ts`) must be enforced per profile with no greedy fallback
    parser — a lenient recovery parser on `qwen-xml` is where laundering
    hides.
