import { existsSync } from "node:fs";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { Engine } from "../engine";
import { SessionStore } from "../session";
import type { ModelProfile } from "../profiles";
import type { ToolDeps } from "../engine_tool_call";
import { sliceTools } from "../tools/registry";
import { providerFor } from "../commands";
import { listSessions } from "../book";
import { sanitizeForTerminal } from "../term";

// M1c Task 5 — /session and /escalate. Same shape as createModelCommand /
// createApproveCommand in src/commands.ts (a plain `(line) => "handled" |
// "not-command"` factory function, no pi-tui import) so both commands work
// unchanged in the plain REPL's onCommand chain AND the TUI's — the router
// itself doesn't know or care which surface is running it. Lives under
// src/tui/ because it's new M1c surface work, not because it needs pi-tui.
//
// Task 5 final-fix-round (M1): every write() argument here is command-router
// output that can carry an attacker/user-controlled fragment (an echoed
// session id, profile id, or error message) — same belt-and-braces
// double-strip transcript.ts/status.ts/app_helpers.ts apply: sanitizeForTerminal
// (src/term.ts) THEN pi-tui's own stripTerminalSequences (reference §6).
function sanitize(s: string): string {
  return stripTerminalSequences(sanitizeForTerminal(s));
}

/** Shared "what's active right now" pointer both commands read/write —
 * `/model` (via createModelCommand's onSwap) keeps `.current` up to date;
 * `/session` reads it to rebuild the Engine over the SAME profile/tools
 * without needing its own copy of "which profile is active" tracking. */
export type ProfileBox = { current: ModelProfile };

/** Task 5 final-fix-round (I1): the store /model and /escalate rebuild the
 * Engine over. Before this box existed, createModelCommand closed over
 * whatever SessionStore main() started it with FOREVER — so a /session
 * resume, followed by a /model (or /escalate, which reuses /model's swap
 * path) swap, silently reverted every SUBSEQUENT turn back to the ORIGINAL
 * session's file while the statusline kept showing the resumed id. Both
 * createModelCommand (src/commands.ts) and createSessionCommand below read
 * and write the SAME box, so whichever command swapped last wins for both. */
export type StoreBox = { current: SessionStore };

export type SessionCommandDeps = {
  engineBox: { current: Engine };
  profileBox: ProfileBox;
  storeBox: StoreBox;
  tools?: ToolDeps;
  providerForFn?: typeof providerFor;
  write: (s: string) => void;
  /** Fires once per successful resume, after engineBox/storeBox are updated
   * — lets the TUI wiring refresh the statusline's session id + live
   * provider name. */
  onResumed?: (info: { sessionId: string; providerName: string }) => void;
};

/**
 * Bare `/session` -> `listSessions()` (book.ts; already sanitized, id + mtime
 * + first-user-line preview). `/session <id>` -> rebuilds the Engine over
 * THAT session's store, keeping the CURRENTLY active profile and tools
 * (mirrors createModelCommand's rebuild-through-engineBox pattern) and
 * writes a "resumed <id8>" line. An id that fails SessionStore's own
 * validation, or one with no session file on disk, is reported as ONE error
 * line — no crash, no switch, engineBox/storeBox untouched.
 */
export function createSessionCommand(deps: SessionCommandDeps): (line: string) => "handled" | "not-command" {
  const buildProvider = deps.providerForFn ?? providerFor;

  return (line: string) => {
    if (line !== "/session" && !line.startsWith("/session ")) return "not-command";
    const arg = line.slice("/session".length).trim();

    if (arg === "") {
      deps.write(listSessions());
      return "handled";
    }

    let store: SessionStore;
    try {
      store = new SessionStore(arg);
    } catch (err) {
      deps.write(sanitize(`raziel: ${err instanceof Error ? err.message : String(err)}\n`));
      return "handled";
    }
    // A syntactically valid id with no file on disk isn't "resumable" —
    // same one-line-error, no-crash contract as an invalid id.
    if (!existsSync(store.path)) {
      deps.write(sanitize(`raziel: unknown session ${JSON.stringify(arg)}\n`));
      return "handled";
    }

    let providerName: string;
    let engine: Engine;
    try {
      const provider = buildProvider(deps.profileBox.current);
      providerName = provider.name;
      const tools: ToolDeps | undefined = deps.tools
        ? {
            registry: sliceTools(deps.tools.registry, deps.profileBox.current.maxToolSurface),
            ws: deps.tools.ws,
            approvals: deps.tools.approvals,
          }
        : undefined;
      engine = new Engine({ provider, store, profile: deps.profileBox.current, tools });
    } catch (err) {
      // Same UX as an unknown profile / missing-key provider error elsewhere:
      // one-line error, no swap, no crash.
      deps.write(sanitize(`raziel: ${err instanceof Error ? err.message : String(err)}\n`));
      return "handled";
    }

    deps.engineBox.current = engine;
    deps.storeBox.current = store; // I1: so a later /model or /escalate swap keeps this session
    const id8 = sanitize(store.id).slice(0, 8);
    deps.write(sanitize(`resumed ${id8}\n`));
    deps.onResumed?.({ sessionId: store.id, providerName });
    return "handled";
  };
}

/**
 * `/escalate` -> if the active profile declares `escalateTo`, behaves
 * EXACTLY as `/model <escalateTo>` by literally calling the supplied
 * `modelCmd` (createModelCommand's own handler — same store (via its own
 * storeBox — see I1's note above), tools re-sliced, same error handling for
 * an unknown/keyless target), then adds an "escalated to <id>" line ONLY if
 * that swap actually succeeded (detected via engineBox identity change —
 * modelCmd already reported its own error line on failure, so nothing
 * further is written in that case). Without an `escalateTo`, writes
 * "no escalation target for <profile>" and does nothing else.
 */
export function createEscalateCommand(deps: {
  engineBox: { current: Engine };
  profileBox: ProfileBox;
  modelCmd: (line: string) => "handled" | "not-command";
  write: (s: string) => void;
}): (line: string) => "handled" | "not-command" {
  return (line: string) => {
    if (line !== "/escalate") return "not-command";

    const profile = deps.profileBox.current;
    const target = profile.escalateTo;
    if (!target) {
      deps.write(sanitize(`no escalation target for ${profile.id}\n`));
      return "handled";
    }

    const before = deps.engineBox.current;
    deps.modelCmd(`/model ${target}`);
    if (deps.engineBox.current !== before) {
      deps.write(sanitize(`escalated to ${target}\n`));
    }
    return "handled";
  };
}
