import type { Component, TUI } from "@earendil-works/pi-tui";
import type { ApprovalDeps } from "../approvals";
import type { RiskClass } from "../tools/types";

// M1c Task 3 — inline approvals in the TUI. Split like surface.ts /
// transcript.ts: makeTuiAsk below is pure headless logic (testable against a
// fake `ui`, no pi-tui import at the call site — see tests/tui-approvals.test.ts),
// and ApprovalCardComponent + makeTuiAskUi is the thin pi-tui wiring that
// satisfies the same `ui` adapter shape for a real running TUI.
//
// Card body handling: buildCard() (src/approvals.ts) is ALREADY
// forgery-hardened (M1b escapeForCard on every interpolated line — see that
// file's doc comment). Nothing here re-escapes, truncates, or reformats it:
// makeTuiAsk forwards the `card` argument to `ui.showCard` verbatim on the
// first call for a given ask() (asserted byte-identical in tests), and
// ApprovalCardComponent only ever does `card.split("\n")` — the exact
// inverse of buildCard's own `lines.join("\n")` — wrapping the result in
// frame-chrome lines of its own rather than touching the body.
//
// Timer/race logic mirrors createAsk (src/ask.ts): high/critical risk races
// a deny-default timer (unref'd, so a pending prompt never keeps the
// process alive) against the first key press; a key arriving after the
// timer already resolved must not re-resolve or re-run any side effect
// (single resolution). NOT imported from createAsk: that module's contract
// is write()+readLine():Promise<string> against ONE shared input stream, so
// a late answer there risks being misread as the reply to the NEXT REPL
// question — hence its explicit "input ignored" notice. This module's
// `ui.onKey` is a callback scoped to this one ask() call instead, so there
// is no shared-stream ambiguity to warn about; the `settled` guard below
// (plus unsubscribing) is the structural equivalent of that same
// single-resolution guarantee, adapted to keys, without a text notice — the
// `ui` adapter has no write channel of its own (showCard/hideCard/onKey
// only, per the plan's interface).

const DEFAULT_DENY_TIMEOUT_MS = 30_000;
const COUNTDOWN_TICK_MS = 1_000;

export type TuiAskUi = {
  showCard(card: string, risk: RiskClass): void;
  hideCard(): void;
  onKey(handler: (k: string) => void): () => void;
};

/** Builds the TUI-facing ApprovalDeps.ask. Keys: "y"=allow, "a"=always, any
 * other key=deny (mirrors the REPL's createAsk). High/critical risk shows a
 * live "auto-deny in Ns" countdown line, ticking every `tickMs`, and races a
 * deny-default timer; low/medium waits for a key indefinitely, same split as
 * createAsk. `tickMs` defaults to COUNTDOWN_TICK_MS (1s) and is a new
 * trailing optional parameter — existing 1- and 2-arg call sites/tests are
 * unaffected. */
export function makeTuiAsk(
  ui: TuiAskUi,
  timeoutMs: number = DEFAULT_DENY_TIMEOUT_MS,
  tickMs: number = COUNTDOWN_TICK_MS,
): ApprovalDeps["ask"] {
  return (card, risk) =>
    new Promise<"allow" | "deny" | "always">((resolve) => {
      let settled = false;
      let tickTimer: ReturnType<typeof setInterval> | undefined;
      let denyTimer: ReturnType<typeof setTimeout> | undefined;

      const stopTimers = (): void => {
        if (tickTimer !== undefined) clearInterval(tickTimer);
        if (denyTimer !== undefined) clearTimeout(denyTimer);
        tickTimer = undefined;
        denyTimer = undefined;
      };

      const finish = (result: "allow" | "deny" | "always"): void => {
        if (settled) return;
        settled = true;
        stopTimers();
        unsubscribe();
        ui.hideCard();
        resolve(result);
      };

      const unsubscribe = ui.onKey((key) => {
        // Late key after expiry — ignored, never re-resolves (single
        // resolution, mirrors createAsk's race guarantee).
        if (settled) return;
        if (key === "y") finish("allow");
        else if (key === "a") finish("always");
        else finish("deny");
      });

      // First call: the card verbatim, no countdown line appended — this is
      // the byte-identical call buildCard's output must match exactly.
      ui.showCard(card, risk);

      if (risk === "high" || risk === "critical") {
        // Tick-counted, not Date.now()-derived: a wall-clock
        // ceil((deadline-now)/1000) collapses to one unchanging value for
        // any sub-second timeoutMs (exactly the injected-test case), which
        // made the countdown structurally unobservable as "live" below 1s.
        // Decrementing by one whole second per tick instead — accurate for
        // the real default (tickMs===1000, one tick per second) and still
        // deterministically produces multiple distinct rendered values for
        // a short injected tickMs, which is what the test asserts.
        let secondsLeft = Math.max(1, Math.ceil(timeoutMs / 1000));
        const renderCountdown = (): void => {
          ui.showCard(`${card}\nauto-deny in ${secondsLeft}s`, risk);
        };
        renderCountdown();
        tickTimer = setInterval(() => {
          secondsLeft = Math.max(0, secondsLeft - 1);
          renderCountdown();
        }, tickMs);
        tickTimer.unref?.();
        denyTimer = setTimeout(() => finish("deny"), timeoutMs);
        denyTimer.unref?.();
      }
    });
}

// --- Thin pi-tui wiring -----------------------------------------------

/** Minimal Component that displays the card lines verbatim between two
 * frame-chrome lines it owns itself. `card.split("\n")` is the exact
 * inverse of buildCard's `lines.join("\n")` — no re-wrapping (a Text
 * component would word-wrap and could reflow a line), no truncation. */
class ApprovalCardComponent implements Component {
  private lines: string[] = [];

  setCard(card: string, risk: RiskClass): void {
    this.lines = [`┌─ approve [${risk}] ────`, ...card.split("\n"), "└─ y=allow  a=always  other=deny"];
  }

  clearCard(): void {
    this.lines = [];
  }

  render(_width: number): string[] {
    return this.lines;
  }

  invalidate(): void {}
}

/** Builds the real `TuiAskUi` adapter for a running TUI: mounts/unmounts an
 * ApprovalCardComponent as a direct child of `tui`, and forwards raw
 * terminal input bytes through as `onKey`'s key argument. */
export function makeTuiAskUi(tui: TUI): TuiAskUi {
  const card = new ApprovalCardComponent();
  let mounted = false;

  return {
    showCard(text, risk) {
      card.setCard(text, risk);
      if (!mounted) {
        tui.addChild(card);
        mounted = true;
      }
      tui.requestRender();
    },
    hideCard() {
      if (mounted) {
        tui.removeChild(card);
        mounted = false;
      }
      card.clearCard();
      tui.requestRender();
    },
    onKey(handler) {
      // Raw terminal bytes, forwarded unfiltered/unsanitized — safe because
      // makeTuiAsk's key check is exact-string ("y"/"a"/else-deny) behind
      // its settled guard, so arbitrary or malformed input can only ever
      // resolve to a safe deny, never reach the card body or double-resolve.
      return tui.addInputListener((data) => {
        handler(data);
        return { consume: true };
      });
    },
  };
}
