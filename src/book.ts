import { SessionStore } from "./session";
import type { SessionEvent } from "./events";
import { sanitizeForTerminal } from "./term";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";

function colorOn(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
}

function paint(code: string, s: string): string {
  return colorOn() ? `${code}${s}${RESET}` : s;
}

function hms(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "??:??:??" : d.toISOString().slice(11, 19);
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

type TurnBody =
  | { kind: "text"; text: string }
  | { kind: "interrupted"; text: string }
  | { kind: "error"; message: string }
  | null;

type Turn = { user: string; body: TurnBody; stop: "end" | "interrupt" | "error"; ts: string };

/** Groups a flat event log into turns: (user line, response body, turn-end). */
function collectTurns(events: SessionEvent[]): Turn[] {
  const turns: Turn[] = [];
  let userText: string | null = null;
  let body: TurnBody = null;

  for (const e of events) {
    if (e.type === "user_message") {
      userText = e.text;
      body = null;
    } else if (e.type === "assistant_message") {
      body = { kind: "text", text: e.text };
    } else if (e.type === "error") {
      body = { kind: "error", message: e.message };
    } else if (e.type === "turn_end") {
      if (userText === null) continue;
      const partial = body !== null && body.kind === "text" ? body.text : "";
      const finalBody: TurnBody = e.stop === "interrupt" ? { kind: "interrupted", text: partial } : body;
      turns.push({ user: userText, body: finalBody, stop: e.stop, ts: e.ts });
      userText = null;
      body = null;
    }
    // tool_request / approval_request / approval_decision / tool_result /
    // any future or torn event type: not yet rendered — skipped gracefully.
  }
  return turns;
}

/** Pretty-prints a session's event log as a transcript. Pure: no I/O. */
export function renderBook(events: SessionEvent[]): string {
  if (events.length === 0) return `${paint(DIM, "(the book is empty)")}\n`;

  const lines: string[] = [];
  let userText: string | null = null;
  let turnBody: TurnBody = null;
  let turnStop = "end";
  let turnTs = "";

  for (const e of events) {
    if (e.type === "user_message") {
      userText = e.text;
      turnBody = null;
    } else if (e.type === "assistant_message") {
      turnBody = { kind: "text", text: e.text };
    } else if (e.type === "error") {
      turnBody = { kind: "error", message: e.message };
    } else if (e.type === "turn_end") {
      // Render the accumulated turn
      if (userText !== null) {
        lines.push(`  ${paint(CYAN, "›")} ${sanitizeForTerminal(userText)}`);
        if (e.stop === "interrupt" && turnBody?.kind === "text") {
          const marker = paint(YELLOW, "⊘ interrupted");
          const text = sanitizeForTerminal(turnBody.text);
          lines.push(text ? `  ${marker} — ${text}` : `  ${marker}`);
        } else if (turnBody?.kind === "text") {
          lines.push(`  ${sanitizeForTerminal(turnBody.text)}`);
        } else if (turnBody?.kind === "error") {
          lines.push(`  ${paint(RED, `✗ error: ${sanitizeForTerminal(turnBody.message)}`)}`);
        } else if (e.stop === "interrupt") {
          lines.push(`  ${paint(YELLOW, "⊘ interrupted")}`);
        }
        lines.push(`  ${paint(DIM, `· ${e.stop} ${hms(e.ts)}`)}`);
        lines.push("");
      }
      userText = null;
      turnBody = null;
    } else if (e.type === "tool_request") {
      const hash = sanitizeForTerminal((e.argsHash as string).slice(0, 8));
      const tool = sanitizeForTerminal(e.tool);
      lines.push(`  ${paint(CYAN, "⚙")} tool_request ${tool} ${hash}`);
    } else if (e.type === "approval_request") {
      const risk = sanitizeForTerminal((e as any).risk as string);
      const tool = sanitizeForTerminal(e.tool);
      lines.push(`  ${paint(YELLOW, "?")} approval_request ${tool} ${paint(YELLOW, `[${risk}]`)}`);
    } else if (e.type === "approval_decision") {
      const decision = sanitizeForTerminal(e.decision);
      lines.push(`  ${paint(CYAN, "→")} approval_decision ${decision}`);
    } else if (e.type === "tool_result") {
      const tool = sanitizeForTerminal(e.tool);
      const ok = (e as any).ok as boolean;
      const statusMarker = ok ? paint(CYAN, "✓") : paint(RED, "✗");
      lines.push(`  ${statusMarker} tool_result ${tool}`);
      const output = sanitizeForTerminal(e.output);
      if (output) {
        lines.push(`  ${output}`);
      }
    }
  }

  return lines.join("\n") + "\n";
}

/** Lists known sessions, newest first, with event count + a first-message preview.
 * A filename that fails session-id validation (planted by a non-raziel
 * writer — SyncThing sync, backup restore: F1's own threat model) is
 * skipped rather than crashing the whole listing; the count of skipped
 * files is summarized in one final line, no raw ids echoed. */
export function listSessions(): string {
  const ids = SessionStore.list();
  if (ids.length === 0) return `${paint(DIM, "(the book is empty)")}\n`;
  const rows: string[] = [];
  let unlistable = 0;
  for (const id of ids) {
    try {
      const events = new SessionStore(id).replay();
      const first = events.find((e) => e.type === "user_message");
      const preview = first ? truncate(sanitizeForTerminal(first.text), 60) : paint(DIM, "(no messages)");
      rows.push(`  ${sanitizeForTerminal(id)}  ${paint(DIM, `${events.length} events`)}  ${preview}`);
    } catch {
      unlistable++;
    }
  }
  if (unlistable > 0) rows.push(`  ${paint(DIM, `(+${unlistable} unlistable session files ignored)`)}`);
  return rows.join("\n") + "\n";
}
