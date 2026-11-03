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
║      (pre-alpha, built in public)    ║
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
commands and edits files on your machine; read [SECURITY.md](SECURITY.md) and do not point it at
anything you cannot afford to lose.

**What exists** (each item backed by code and tests in this repo):
- Event-sourced sessions: an append-only JSONL log per session, replayable (`src/session.ts`, `src/events.ts`).
- A bounded tool loop (read/write/edit files, glob/grep, run command, fetch) with risk classes,
  interactive approvals, and per-launch grants for unattended runs (`src/tools`, `src/approvals.ts`, `src/grant.ts`).
- A context budget that evicts old tool results behind re-readable stubs (`src/context_budget.ts`).
- Four provider doors: Anthropic (API key only), OpenAI Responses, OpenAI-compatible, ollama native tools (`src/providers`).
- `doctor`: checks each built-in profile is configured and reachable using free listing calls
  (no tokens spent), and prints the fix for whatever is missing (`src/doctor.ts`).
- Plain-English errors for the day-one failures (no key, wrong key, provider unreachable, unknown
  model, ollama not running): one line naming the env var, flag or command that fixes it.
- A terminal UI built on pi-tui (`src/tui`).
- 504 tests (`bun test`).

**What does not exist yet:**
- ACP. There is no ACP code in `src/`; the "one engine, many surfaces" design in
  [docs/SPEC.md](docs/SPEC.md) is a plan.
- The security "wall" (a sandboxed/brokered executor). Today's protection is the approval and
  grant system only, which is not a sandbox.
- Session log redaction. Logs are plaintext.

## What Raziel will and will not do without asking

Derived from `src/approvals.ts` (the order of checks), `src/rules.ts` (standing rules) and
`src/risk.ts` (risk classes). Applies to every tool call the model makes.

| Risk | Which calls | Without asking? |
|---|---|---|
| low | `read_file`, `glob`, `grep` inside the workspace | Only if a standing rule matches (or a `read`/`write` grant covers it); otherwise asks |
| medium | `write_file`, `edit_file` inside the workspace; `fetch` of a public URL | Only if a standing rule matches (or a `write`/`fetch` grant covers it); otherwise asks |
| high | every `run_command`; `fetch` of `localhost` or a private IP | **Never by a standing rule.** Asks; unanswered for 30 s it is denied. Under a grant, only a `run_command` whose argv starts with an `--allow-run` prefix |
| critical | a path that escapes the workspace, an unknown tool, arguments that are not an object or lack the required `path`/`url` | **Never.** Refused without asking, under any rule or grant |

- **Standing rules** live in `~/.raziel/rules.json`, written owner-only (`0600`). Answering `a` (always) to a prompt saves one
  for that tool with exactly those arguments; it is not saved if the arguments contain `*`. A rule
  that is only wildcards is refused. `/approve` lists rules and `/approve rm <n>` removes one. A
  rules file that cannot be read or parsed counts as no rules.
- **Grants** (`--grant read|write|fetch`, `--allow-run "<argv prefix>"`, `src/grant.ts`) make a run
  unattended: anything a grant or standing rule does not cover is denied at once, with the reason
  printed and recorded, and nothing is ever asked. A grant lasts for one launch.
- Every call and its result, refusals included, is written to the session log.

## Roadmap

Build order: `raziel acp` (ACP server), log redaction (log file permissions are done), v0.1
packaging, a benchmark, then the walled executor. Details in [docs/SPEC.md](docs/SPEC.md).

Print the card yourself: `bash scripts/party-card.sh`

## Quickstart

Needs [bun](https://bun.sh). Pick one door: an Anthropic API key, a local ollama, or any
OpenAI-compatible endpoint.

```sh
git clone https://github.com/dillondevoe/raziel && cd raziel
bun install

# then ONE of:
export ANTHROPIC_API_KEY=sk-ant-api...    # console API key; default profile "sonnet"
#   or: ollama pull qwen2.5:7b            # local; run with --profile qwen
#   or: export RAZIEL_COMPAT_URL=http://localhost:8000/v1 RAZIEL_COMPAT_KEY=<key, any value if keyless>
#       # run with --profile astra --model <a model your server serves>; chat only, no tools

bun run src/cli.ts doctor                 # which doors are configured and reachable (no tokens spent)
bun run src/cli.ts                        # or: --profile qwen / --profile astra --model <name>
```

Subscription tokens (`sk-ant-oat…`) are refused; the Anthropic door takes a console API key only.
`--model <name>` overrides the profile's model for any provider. `RAZIEL_OLLAMA_URL` points the qwen
profile at an ollama on another host. `RAZIEL_FAKE=1` runs with a canned reply and no model, to try
the interface. `RAZIEL_DEBUG=1` prints a stack trace on an unexpected crash. The astra profile looks
for an optional persona file at `~/.raziel/profiles/astra.md` and warns on stderr when it is absent.

Design: [docs/SPEC.md](docs/SPEC.md)
