#!/usr/bin/env bash
# party-card.sh — Raziel's RPG card. ASCII art, for the record.
# Usage: ./scripts/party-card.sh

_CYAN=$'\033[1;36m'
_DIM=$'\033[2m'
_RESET=$'\033[0m'

printf '%s' "$_CYAN"
cat <<'EOF'
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
EOF
printf '%s\n' "$_RESET"
