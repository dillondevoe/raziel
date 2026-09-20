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
║  Ward: Agent OS security wall        ║
╠══════════════════════════════════════╣
║  ◇ ACP, not app-per-surface          ║
║  ◇ Logs every event, on purpose      ║
║                                      ║
║  "one letter from agent to angel"    ║
╚══════════════════════════════════════╝
```

# Raziel

**The angel who keeps the Book of Secrets — and one letter from "agent" to "angel."**

A terminal-first AI agent harness, built in public. One engine, many surfaces (ACP),
event-sourced sessions, real support for small local models, and — on
[Agent OS](https://github.com/dillondevoe/agent-os) — a security wall by construction.

Status: **past M0, shipping itself.** Event-sourced sessions with a context budget, a bounded tool loop
behind approvals and per-launch grants, four provider doors (Anthropic API key, OpenAI Responses,
OpenAI-compatible, ollama native tools), and models that land their own PRs through it unattended.
463 tests. Every event is still logged, on purpose.

Print the card yourself: `bash scripts/party-card.sh`

## Run
```sh
export ANTHROPIC_API_KEY=...
bun run src/cli.ts
```

Design: [docs/SPEC.md](docs/SPEC.md)
