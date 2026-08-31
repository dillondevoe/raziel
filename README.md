# Raziel

**The angel who keeps the Book of Secrets — and one letter from "agent" to "angel."**

A terminal-first AI agent harness, built in public. One engine, many surfaces (ACP),
event-sourced sessions, real support for small local models, and — on
[Agent OS](https://github.com/dillondevoe/agent-os) — a security wall by construction.

Status: **M0 spike.** It holds a conversation and logs every event. That's it, on purpose.

## Run
```sh
export ANTHROPIC_API_KEY=...
bun run src/cli.ts
```

Design: [docs/SPEC.md](docs/SPEC.md)
