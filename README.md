```
╔══════════════════════════════════════╗
║  RAZIEL                          📖👼 ║
║  Angel · Keeper of the Book          ║
╠══════════════════════════════════════╣
║  Lane: One engine, many surfaces     ║
║                                      ║
║  Event Log      ██████████  10/10    ║
║  Local Models   ████████░░   8/10    ║
║  Scope Restraint ██████████  10/10   ║
║      (it ships itself, unattended)   ║
║                                      ║
║  Ward: security wall (planned)       ║
╠══════════════════════════════════════╣
║  ◇ ACP surfaces (planned)            ║
║  ◇ Logs every event, on purpose      ║
║                                      ║
║  "one letter from agent to angel"    ║
╚══════════════════════════════════════╝
```

# Raziel

**The angel who keeps the Book of Secrets — and one letter from "agent" to "angel."**

A terminal-first AI agent harness, built in public. Today it is a TUI/CLI with event-sourced
sessions, approval-gated tools, and support for small local models. Planned, not built: an
[ACP](https://agentclientprotocol.com) server so other editors can drive it, and a walled executor
on [Agent OS](https://github.com/dillondevoe/agent-os).

## Status: pre-alpha

Expect breaking changes, no packaged release, and rough edges. Raziel runs an agent that executes
commands and edits files on your machine; read [SECURITY.md](SECURITY.md) once it lands and do not
point it at anything you cannot afford to lose.

**What exists** (each item backed by code and tests in this repo):
- Event-sourced sessions: an append-only JSONL log per session, replayable (`src/session.ts`, `src/events.ts`).
- A bounded tool loop (read/write/edit files, glob/grep, run command, fetch) with risk classes,
  interactive approvals, and per-launch grants for unattended runs (`src/tools`, `src/approvals.ts`, `src/grant.ts`).
- A context budget that evicts old tool results behind re-readable stubs (`src/context_budget.ts`).
- Four provider doors: Anthropic (API key only), OpenAI Responses, OpenAI-compatible, ollama native tools (`src/providers`).
- A terminal UI built on pi-tui (`src/tui`).
- 463 tests (`bun test`).

**What does not exist yet:**
- ACP. There is no ACP code in `src/`; the "one engine, many surfaces" design in
  [docs/SPEC.md](docs/SPEC.md) is a plan.
- The security "wall" (a sandboxed/brokered executor). Today's protection is the approval and
  grant system only, which is not a sandbox.
- Session log redaction. Logs are plaintext.

## Roadmap

Build order: `raziel acp` (ACP server), log hygiene (permissions, then redaction), v0.1
packaging, a benchmark, then the walled executor. Details in [docs/SPEC.md](docs/SPEC.md).

Print the card yourself: `bash scripts/party-card.sh`

## Run
```sh
export ANTHROPIC_API_KEY=...
bun run src/cli.ts
```

Design: [docs/SPEC.md](docs/SPEC.md)
