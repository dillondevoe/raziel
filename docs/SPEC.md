---
title: SPEC — Raziel: one engine, ACP surfaces, Air daily-driver + agent-os shell
author: geist (Air), with Dillon interactive
date: 2026-08-30
status: SPEC — approved by Dillon 2026-08-30 (design in-session; §8 answered); next: implementation plan
provenance: dillon (goals, choices) + web (landscape scan, verified 2026-08-30) + inferred (design)
inputs:
  - Landscape scan (subagent, 2026-08-30): pi/omp, OpenCode, Crush, goose, Aider, Codex CLI,
    Gemini CLI, Hermes-agent, Cline, Qwen Code; SDKs; TUI libs; MCP/ACP/AG-UI; local tool-calling
  - ~/agent-os — bin/agent-loop v0.2 (wall architecture), configuration-open.nix
  - Dillon leads: omp.sh (oh-my-pi), timtoole02/camelid (Rust local inference)
---

# 0. What this is

**Raziel** (the angel who keeps the Book of Secrets; also one letter from "agent" to "angel") — Dillon's harness: a terminal-first AI agent he builds and owns — the craft goal is
"master harness builder," the product goal is a daily-driver that beats renting someone
else's harness. **One program, two configurations:**

- **Air daily-driver** (v1): drives any model (Anthropic, ollama, Camelid, Nous, any
  OpenAI-compatible), edits files, runs commands, approval-gated. Success bar, Dillon's
  words: *he chooses it over Claude Code for a week of real work.*
- **agent-os shell** (v1.5): the same binary boots as agent-os's tty1 experience, drives
  the local Qwen, and swaps its hands for agent-os's wall (`mcp parse | broker run`).
  Nothing forked; a config flag chooses hands + model.

Decisions locked in-session (Dillon, 2026-08-30, interactive on Air):
identity = **both, staged** · surface = **TUI + local web panel** (panel is v2) ·
posture = **own the engine, borrow rendering + provider plumbing, adopt open protocols** ·
success = **daily-driver test** · novelty lanes = **all three** (§5).

# 1. Landscape facts the design rests on (scan, verified 2026-08-30)

- **pi** (`earendil-works/pi`, MIT, ~99k★; omp/oh-omp is its batteries fork) publishes the
  only purpose-built MIT harness components: `pi-ai` (multi-provider client incl. local),
  `pi-agent-core`, `pi-tui` (differential renderer, streaming markdown, real editor).
  Vercel AI SDK v7 lists Pi as a supported harness runtime.
- **ACP** (Agent Client Protocol, Zed) is v1-stable and adopted by Gemini CLI, Codex,
  OpenCode, goose, Qwen Code; clients: Zed, JetBrains, Neovim, Emacs. It is the LSP of
  agents. **MCP** (spec 2026-07-28, Linux Foundation) is mandatory client-side.
- Everyone who scaled **Ink** forked or patched it. pi-tui exists to escape that.
- **Local small models need first-class special-casing**: ollama tools break on the
  OpenAI-compat `/v1` path (use native `/api/chat`); 4K default context silently kills
  tool use (force 32K); quality degrades past ~8 tools; Qwen3-Coder speaks its own XML.
- Avoid as bases: Aider (maintenance mode), Claude Agent SDK (closed-binary wrapper,
  local "not planned"), Crush (FSL license), stock Ink.
- **Camelid** (`timtoole02/camelid`, MIT, Rust): local inference backend,
  OpenAI-compatible; supported here as a provider endpoint (also routed to Scout for
  fleet evaluation — separate thread).

# 2. Architecture

```
             surfaces (ACP clients): TUI v1 · web panel v2 · agent-os tty1 v1.5
                                   · Zed/Neovim (free via ACP)
                        │ ACP (JSON-RPC over stdio)
             ┌──────────┴─────────────────────────────┐
             │ ENGINE (ours, TypeScript/Bun)          │
             │ session=event log · turn loop ·        │
             │ approvals · model profiles (lane 1)    │
             ├──────────┬──────────────┬──────────────┤
             │ providers│ tool-exec    │ memory        │
             │ (pi-ai + │ interface    │ (markdown,    │
             │ adapters)│ (lane 2)     │ lane 3)       │
             └────┬─────┴──────┬───────┴───────────────┘
        cloud + local       direct: builtins+MCP+approvals
        (Anthropic, OpenAI- walled: mcp parse | broker run
        compat, ollama      (agent-os; deny/garble/hang →
        /api/chat, Camelid) one fail-closed shape)
```

Load-bearing properties:
1. **Session = append-only typed event log** (JSONL per session). Renders the TUI, replays
   the web panel, audits agent-os, and is the test-fixture format. Crash-safe by replay.
2. **ACP is the only door into the engine.** Our TUI is merely ACP client #1. Web panel is
   #2. Editors come free. No invented protocol.
3. **Tool execution is one interface, two implementations** (`direct`, `walled`). The
   engine is identical on the Air and on agent-os.

# 3. Engine components (the part we write)

1. **Session store** — `~/.raziel/sessions/<id>.jsonl`; events: `user_message`,
   `assistant_delta`, `tool_request`, `approval_request`, `approval_decision`,
   `tool_result`, `turn_end`, `error` (+ `interrupt` as a recorded event).
2. **Turn loop** (~500 lines): input → context from log → stream model → collect tool
   calls → approval policy → tool interface → results back → repeat. Emits events only;
   zero UI/provider/security logic inside.
3. **Model profiles** *(lane 1)* — per-model data + small strategy fns: context budget,
   max tool surface, parser (Hermes-JSON vs Qwen3-Coder XML), sampling, streaming-tools
   capability, escalation hints. Same loop behaves correctly on claude-* and qwen3.5:9b.
4. **Approval policy** — pluggable ladder: `ask-everything` → `ask-risky` (allowlists;
   an "always" answer writes a visible, revocable rule) → `walled` (defer to broker).
   Decisions are events: the log shows who approved what, forever.
5. **Provider layer** — thin adapters over `pi-ai`; ollama via native `/api/chat`;
   any OpenAI-compatible endpoint (Camelid, Nous). Interface:
   `stream(messages, tools, profile) → deltas`.

# 4. TUI (v1 surface)

Built on `pi-tui`. Opinions, not plumbing:
- Transcript IS the app: streaming markdown + highlighting; tool calls as collapsible
  cards; diffs as diffs; inline approvals (`y/n/a`, with `a` writing an inspectable rule).
- Truthful statusline: model+profile, real token count, session cost, live executor
  (`direct`/`walled`), tok/s on local models.
- `/model` hot-swap mid-session · `/session` list/resume/fork · `/compact` ·
  `/approve` (review standing rules) · Esc = clean first-class interrupt event.
- Escalation as a keystroke *(lane 1 UI)*: local model punts → "escalate this turn to
  <cloud model>?" — RIGHTSIZING doctrine as UX.
- v1 explicitly excludes: themes, plugin marketplace, multi-pane, mouse. Depth over area.

# 5. Novelty lanes (all three approved; spike-budgeted, evidence-gated, kill criteria
written before each spike — house doctrine)

- **Lane 1 — small-model discipline.** Model capability profiles as a first-class
  abstraction; tool-surface budgeting; parser strategies; local→cloud escalation ladders.
  Benchmarked (tool-call success per profile), not vibed. Lab: agent-os + Dell.
- **Lane 2 — the wall as product.** Security-boundary harness: untrusted loop, broker,
  taint propagated into the event log, per-session capability tiers, fail-closed
  everywhere. Thesis: "a harness whose security story is architecture, not vibes."
- **Lane 3 — life-OS surface.** Boot-into-it shell, markdown memory, multi-brain routing.
  Staged AFTER the daily-driver bar (v2+); v1 keeps only the seams (memory module,
  ACP multi-client) that make it possible later.

# 6. Tools

- Built-ins v1: read/write/edit file, run command, grep/glob, fetch URL — each with a
  declared risk class the approval policy reads.
- MCP client v1: spec 2026-07-28, stdio servers first.
- Walled executor v1.5: same interface, routed through agent-os's
  `mcp parse | broker run`; deny/garble/hang collapse to one fail-closed result.

# 7. Milestones & proof

- **M0 spike (~days):** engine skeleton + event log + Anthropic provider + bare TUI.
  Proof: a real conversation in it.
- **M1 daily-driver alpha:** builtins + approvals + session resume + `/model` with
  ollama + 2 model profiles. Proof: **Dillon uses it a week over Claude Code.**
- **M1.5 agent-os shell:** walled executor + qwen profile + tty1 config. Proof: the box
  boots into it and feels shockingly good local-first.
- **M2:** web panel (ACP client #2), lane deep-dives, Zed/Neovim verified free.
- Every milestone: replay-test suite green (event-log fixtures vs fake provider) + one
  honest lane-1 benchmark. TDD per house workflow.

# 8. Decisions (Dillon, 2026-08-30, interactive)

1. **Name: Raziel.** Binary `raziel`, state dir `~/.raziel/`. Collision sweep 2026-08-30:
   `dillondevoe/raziel` free; brew free; unscoped npm `raziel` squatted by an abandoned
   password CLI (0.0.5) — publish under a scope if packages ever ship.
2. **Open source, public from day one** — MIT, build-in-public, agent-os style.
3. **Repo: `dillondevoe/raziel`**, developed on the Air.

# 9. Non-goals (v1)

- No plugin marketplace, no themes, no multi-agent swarms, no A2A, no invented protocol,
  no Gamma-wide anything. The web panel ships in v2, not v1. Lane 3 UX ships after the
  daily-driver bar is met.
