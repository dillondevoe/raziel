import { sanitizeForTerminal } from "./term";
import type { RiskClass } from "./tools/types";

const DEFAULT_DENY_TIMEOUT_MS = 30_000;

export type AskDeps = {
  write: (s: string) => void;
  readLine: () => Promise<string | undefined>;
  timeoutMs?: number;
};

/** Builds the REPL-facing ApprovalDeps.ask: writes the card, reads one line
 * ("y"=allow, "a"=always, anything else=deny). HIGH-or-critical-risk asks
 * additionally race a deny-default timer (R14) — if no answer arrives
 * before it fires, the call denies rather than blocking forever. The timer
 * is unref'd so a pending high-risk prompt never keeps the process alive.
 *
 * Fix round (I4): the losing side of that race isn't just discarded.
 * `readLine()` draws from the SAME shared input stream the REPL's own
 * prompt loop uses, so a line that arrives after the timeout already fired
 * would otherwise be silently swallowed (never reaching either this
 * decision OR the next REPL prompt) or — worse — misread as an answer to
 * a question that's already been decided. `.catch` guards a rejecting
 * readLine from becoming an unhandled rejection; once timed out, the
 * still-pending read is watched and, if it later resolves with a real
 * line, a notice is written instead of dropping it silently. */
export function createAsk(deps: AskDeps): (card: string, risk: RiskClass) => Promise<"allow" | "deny" | "always"> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_DENY_TIMEOUT_MS;

  return async (card, risk) => {
    deps.write(`${card}\n`);
    const linePromise = deps.readLine().catch(() => undefined);

    let line: string | undefined;
    if (risk === "high" || risk === "critical") {
      let timedOut = false;
      line = await new Promise<string | undefined>((resolve) => {
        const timer = setTimeout(() => {
          timedOut = true;
          resolve(undefined);
        }, timeoutMs);
        timer.unref?.();
        linePromise.then((v) => {
          clearTimeout(timer);
          resolve(v);
        });
      });
      if (timedOut) {
        linePromise.then((lateLine) => {
          if (lateLine !== undefined) {
            deps.write(sanitizeForTerminal("input ignored — approval already denied") + "\n");
          }
        });
      }
    } else {
      line = await linePromise;
    }

    if (line === "y") return "allow";
    if (line === "a") return "always";
    return "deny";
  };
}
