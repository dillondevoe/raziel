# Raziel M1c — TUI Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bare readline REPL with a pi-tui terminal surface — streaming transcript, inline approvals, truthful statusline, session resume — while keeping the piped/non-TTY REPL path byte-stable.

**Architecture:** A `TuiSurface` layer owns the pi-tui lifecycle (alt-screen, raw mode, crash-safety) and translates between the engine's EngineEvent stream / ApprovalDeps.ask and pi-tui components. The engine, approvals, tools, and providers are untouched. TTY detection picks TUI vs. the existing REPL; every TUI component is headless-testable against a stub Terminal (verified possible — pi-tui's `Terminal` is a plain interface).

**Tech Stack:** @earendil-works/pi-tui@0.84.4 (the milestone's ONE new dependency — R7 vetting note below). Bun + TypeScript strict.

**Spec:** docs/SPEC.md §4 (TUI v1) · **API authority: docs/pi-tui-reference.md — every pi-tui claim in this plan traces there; when this plan and the reference disagree, the reference wins and the implementer notes the discrepancy.** Security authority: docs/security/m1b-security-requirements.md (R7/R8 for the new dep; R11 display integrity extends to TUI rendering).

## Global Constraints

- `bun run typecheck` exits 0 before EVERY commit; full `bun test` green (225 at plan time).
- TDD RAW RED; headless tests use a stub in-memory `Terminal` (the reference's smoke-test pattern) — no PTY in CI.
- Files < 200 lines; no default exports; pi-tui is the only new dependency, pinned exact `0.84.4` (R7: its auth surface is nil — no network code — but note the pin in the report).
- **Non-TTY path byte-stable:** when stdin or stdout is not a TTY (or `RAZIEL_PLAIN=1`), `main()` runs the existing runRepl exactly as today — all existing cli tests and piped smokes pass UNTOUCHED.
- **Sanitization layering (ruling):** Raziel's `sanitizeForTerminal` remains the authoritative pre-persist/pre-display cleaner (unchanged everywhere it exists). TUI rendering ADDITIONALLY passes model/tool text through pi-tui's `stripTerminalSequences()` at the component boundary — belt and braces; neither replaces the other.
- **Ctrl+C (ruling, from the reference):** pi-tui raw mode swallows SIGINT. The TUI intercepts `Key.ctrl("c")` itself: first press during a streaming turn = interrupt (fires the same AbortController path as the REPL's SIGINT handler); press when idle = clean shutdown (`tui.stop()` then exit). The existing `process.on("SIGINT")` handler stays registered for out-of-band signals.
- **Crash safety:** top-level `uncaughtException`/`unhandledRejection`/`exit` handlers restore the terminal (`tui.stop()`) before anything else — a crash may never strand the user in raw mode/alt-screen.
- **Alt-screen (ruling):** transcript uses `TuiAltScreen` + `ScrollView follow:"end"` (the reference: independent scroll + follow only work there). 
- **Truthful statusline (ruling):** shows only what is actually known: profile id + model name, provider name, session id, tool-round activity indicator, and elapsed turn time. Token counts / cost / tok/s are DEFERRED — the Provider contract has no usage channel and M1c does not amend the frozen contract. Ledger this as an M1d item; the statusline must never display an estimated number as if measured.
- v1 exclusions honored (SPEC §4): no themes, no multi-pane, no mouse-dependent flows, no plugin surface. Markdown rendering may use pi-tui's built-in Markdown component as-is; no custom highlighter work.
- Deferred OUT of M1c (on the record): text parsers + qwen tool profile work (M1d, gated on the local-ollama probe — docs/local-toolcall-formats.md; `qwen3.5:9b` has a live ollama template bug #14493), MCP client, R1–R5 profile hygiene (rides user-editable profiles), token/cost statusline (needs a sanctioned Provider usage extension), escalation-on-punt heuristics (v1 ships `/escalate` as an explicit command instead — SPEC lane-1 UX arrives with measurement, not vibes).

## File Structure

```
src/tui/surface.ts      (T1)  lifecycle: alt-screen, raw mode, ctrl-c, crash handlers
src/tui/transcript.ts   (T2)  ScrollView transcript: turns, streaming deltas, tool cards
src/tui/approvals.ts    (T3)  inline approval card + y/n/a keys + deny-timer countdown
src/tui/status.ts       (T4)  statusline component (truthful fields only)
src/tui/session_cmd.ts  (T5)  /session list|resume + /escalate
src/cli.ts              (T1, T5 — TTY branch + command wiring; REPL path untouched)
tests/tui-*.test.ts     (headless, stub Terminal)
```

---

### Task 1: TUI lifecycle shell + TTY routing

**Files:** Create `src/tui/surface.ts`; Modify `src/cli.ts`; Test `tests/tui-surface.test.ts`.

**Interfaces:**
- Produces:

```ts
export type SurfaceDeps = {
  terminal?: Terminal;            // injectable; default ProcessTerminal (TTY only)
  onInterrupt(): void;            // fires the active turn's AbortController (same one the SIGINT handler uses)
  onQuit(): void;                 // clean shutdown request
  isStreaming(): boolean;         // whether a turn is in flight (drives ctrl-c semantics)
};
export class TuiSurface {
  constructor(deps: SurfaceDeps) {}
  start(): void;   // alt-screen up, raw mode on, key routing live, crash handlers installed (idempotent)
  stop(): void;    // full terminal restore; safe to call twice; called by crash handlers
  readonly running: boolean;
}
export function wantsTui(): boolean; // stdin.isTTY && stdout.isTTY && !process.env.RAZIEL_PLAIN
```

- `main()` change: `if (wantsTui()) → TUI path (T5 completes the wiring; in THIS task the TUI path may boot into a minimal "TUI ready — /quit to exit" shell)`, else existing runRepl untouched.
- Ctrl+C routing per the Global Constraints ruling; use pi-tui's `matchesKey(data, Key.ctrl("c"))` (see reference §input).
- Crash handlers: install once in `start()`; each calls `stop()` first, then rethrows/exits as appropriate; `stop()` must be safe when the terminal was never started.

- [ ] **Step 1 (RED):** headless tests with a recording stub Terminal (pattern from the reference's smoke test): `start()` enters alt-screen + raw mode on the stub (assert the control sequences / mode calls the stub recorded); ctrl-c byte while `isStreaming()===true` → `onInterrupt` called once, surface still running; ctrl-c while idle → `onQuit` called; `stop()` restores (assert inverse sequences), second `stop()` no-op; `wantsTui()` false under `RAZIEL_PLAIN=1` (env save/restore).
- [ ] **Step 2:** run — capture RED. **Step 3:** implement. **Step 4:** typecheck + full suite (existing REPL tests must be untouched and green). **Step 5:** commit `feat: tui lifecycle shell — alt-screen, ctrl-c semantics, crash-safe restore`.

---

### Task 2: Transcript component + streaming render

**Files:** Create `src/tui/transcript.ts`; Test `tests/tui-transcript.test.ts`.

**Interfaces:**
- Produces:

```ts
export class Transcript {
  constructor(/* pi-tui parent/container per reference layout section */) {}
  userLine(text: string): void;                    // "› text"
  beginAssistant(turn: string): void;
  appendDelta(turn: string, text: string): void;   // streams into the open assistant block, no full-view rebuild
  endAssistant(turn: string): void;                // finalize block (markdown-render the accumulated text)
  toolCard(evt: { tool: string; risk?: string; ok?: boolean; phase: "request"|"result"; output?: string }): void; // one compact line-card per event; collapsible NOT required in v1 — compact IS the v1 form
  errorLine(msg: string): void;
  interruptMark(turn: string): void;               // visible "· interrupted" marker
}
```

- EVERY string entering a component passes `sanitizeForTerminal` THEN `stripTerminalSequences` (layering ruling). Tool output in cards is truncated to 400 chars with a "… (+N chars, in session log)" tail — the full output lives in the store, the transcript stays readable.
- Streaming uses the reference's documented append/patch idiom for growing text (reference §streaming) — the acceptance test is behavioral: appending 50 deltas causes 50 incremental updates on the stub terminal, not 50 full-frame redraws (assert via the stub's write-call sizes, or the component-level API the reference names for partial update — implementer picks the mechanism the reference documents, cites it in the report).
- [ ] **Step 1 (RED):** headless: render a full scripted turn (user line, 3 deltas, end) → final frame contains the text in order; a delta containing `\x1b]0;evil\x07` renders with no ESC byte in any stub write; toolCard request+result render tool name + risk + ok mark; 100-line transcript keeps follow-at-end (last line visible in final frame).
- [ ] **Steps 2–5:** RED run → implement → typecheck + suite → commit `feat: streaming transcript — sanitized, follow-at-end, tool cards`.

---

### Task 3: Inline approvals in the TUI

**Files:** Create `src/tui/approvals.ts`; Test `tests/tui-approvals.test.ts`.

**Interfaces:**
- Produces:

```ts
export function makeTuiAsk(ui: { showCard(card: string, risk: RiskClass): void; hideCard(): void; onKey(handler: (k: string) => void): () => void }, timeoutMs?: number): ApprovalDeps["ask"];
```

- Reuses `buildCard` output VERBATIM as the card body (the forgery-hardening from M1b must not be re-implemented or bypassed — the card string is already escaped; the TUI wraps it in a visual frame only).
- Keys: `y` allow · `a` always · any other key deny (mirrors REPL semantics); high/critical risk shows a live countdown line ("auto-deny in Ns") driven by the same injectable timer contract as `createAsk` (src/ask.ts) — reuse its timer/race logic if importable without behavior change, else mirror it exactly and say so in the report. The M1b race guarantees hold: one resolution, late keys ignored with the existing "input ignored" semantics adapted to keys.
- [ ] **Step 1 (RED):** headless: ask resolves "allow" on y / "always" on a / "deny" on x; injected 10ms timer with no key → "deny" and the countdown line appeared in stub writes; a key arriving after expiry does not re-resolve (single resolution asserted); card body appears byte-identical to `buildCard`'s output (no re-escaping, no truncation).
- [ ] **Steps 2–5:** commit `feat: inline tui approvals — reuses hardened card, deny-default countdown`.

---

### Task 4: Truthful statusline

**Files:** Create `src/tui/status.ts`; Test `tests/tui-status.test.ts`.

- Fields (ALL known-true, per ruling): `profileId (modelName) · providerName · session <id8> · [tool round k/8 | idle | streaming Ns]`. Update hooks: `setProfile(p)`, `setSession(id)`, `setActivity(a: {kind:"idle"} | {kind:"streaming", startedAt:number} | {kind:"tool", round:number})`. No token counts, no cost, no tok/s — a comment names the M1d deferral and forbids estimated numbers.
- [ ] **Step 1 (RED):** each setter updates the rendered line (stub frame contains the exact expected string); session id is sanitized; switching profile via the setter re-renders.
- [ ] **Steps 2–5:** commit `feat: truthful statusline — knowns only, no estimated numbers`.

---

### Task 5: Wiring — TUI main loop, /session, /escalate

**Files:** Create `src/tui/session_cmd.ts`; Modify `src/cli.ts` (TUI branch), `src/commands.ts` (only if a command needs extraction — mechanical).

**Interfaces:**
- The TUI main loop: an input editor line (pi-tui editor component per reference) feeding the same `onCommand` router the REPL uses — `/model`, `/approve`, and new `/session` + `/escalate` work identically in both surfaces; non-command lines run `engine.current.send()` with deltas → `Transcript.appendDelta`, tool events → `toolCard`, approvals → `makeTuiAsk`, activity → statusline.
- `/session` bare → list sessions (reuse `listSessions` from book.ts — id, mtime, first user line, sanitized); `/session <id>` → validate via the existing session-id containment, rebuild the Engine over THAT session's store (same profile/tools — mirrors `/model`'s rebuild pattern through the engineBox), transcript shows a "resumed <id8>" divider and the engine's replayed context takes effect on the next turn. Invalid/unknown id → one error line, no crash, no switch.
- `/escalate` → if the active profile has `escalateTo`, behaves exactly as `/model <escalateTo>` (reuses createModelCommand's swap path — same store, tools re-sliced) with a transcript line "escalated to <id>"; without `escalateTo` → "no escalation target for <profile>".
- [ ] **Step 1 (RED):** headless end-to-end with FakeProvider: scripted turn streams into the transcript (stub frame assertions); scripted tool_call flows card → y-key → executed → result card (reuses the real ApprovalManager + mkdtemp ws); `/session` lists the two sessions a fixture created; `/session <other-id>` then a turn → new events land in the OTHER session's file; `/escalate` on qwen profile swaps to sonnet (engineBox identity changes, statusline updates); piped non-TTY invocation still byte-stable (existing smoke reused).
- [ ] **Steps 2–5:** commit `feat: tui main loop — /session resume, /escalate, unified command router`.

---

## Self-Review Notes (author, at write time)

- Task granularity: T1/T2/T3/T4 are independently testable components; T5 is the only integration task and consumes all four — reviewable as the seam task. No task amends the Provider contract, events schema, approvals logic, or containment (M1b's hardened core is consumed, never modified).
- Spec §4 coverage: transcript ✅(T2) · inline approvals ✅(T3) · statusline ✅(T4, truthful subset with recorded deferral) · /model ✅(exists) · /session ✅(T5) · /approve ✅(exists) · Esc/interrupt ✅(T1 ctrl-c; Esc-key binding may ride T5 if pi-tui's editor doesn't reserve it — implementer judgment, noted in report) · /compact ❌ DEFERRED to M1d (needs a context-compaction design; not a TUI concern) · escalation keystroke → `/escalate` command (ruling above).
- pi-tui claims all trace to docs/pi-tui-reference.md; if an implementer hits an API mismatch, the reference wins and the discrepancy gets reported, not papered over.
