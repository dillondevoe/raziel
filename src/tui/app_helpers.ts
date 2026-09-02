import { Editor, type EditorTheme, Text, type TUI, stripTerminalSequences } from "@earendil-works/pi-tui";
import { sanitizeForTerminal } from "../term";
import type { TuiAskUi } from "./approvals";

// M1c Task 5 — small, independently-testable helpers pulled out of
// src/tui/app.ts purely to keep that file under the 200-line budget. None of
// these hold any TUI-app-shaped state of their own.
//
// Task 5 final-fix-round (M1): systemLine's text is command-router output —
// includes echoed args (e.g. an unknown /model or /session id) — so it gets
// the same belt-and-braces double-strip transcript.ts and status.ts use:
// sanitizeForTerminal (src/term.ts) THEN pi-tui's own stripTerminalSequences.
function sanitize(s: string): string {
  return stripTerminalSequences(sanitizeForTerminal(s));
}

export const EDITOR_THEME: EditorTheme = {
  borderColor: (t) => t,
  selectList: {
    selectedPrefix: (t) => t,
    selectedText: (t) => t,
    description: (t) => t,
    scrollInfo: (t) => t,
    noMatch: (t) => t,
  },
};

/** Wraps a TuiAskUi so an external `cancelPending()` can force-deny whatever
 * ask() is CURRENTLY pending — used to satisfy requirement A (ctrl+c during
 * an open approval card must resolve it, never hang). Doesn't modify
 * makeTuiAsk/makeTuiAskUi (Task 3, reviewed): it captures the handler
 * makeTuiAsk registers via ui.onKey on every ask() call (re-captured each
 * time, so it always tracks whichever ask is live) and, on cancelPending(),
 * invokes it with a byte that is neither "y" nor "a" — makeTuiAsk's own key
 * switch treats that as an ordinary deny, hides the card, and unsubscribes,
 * exactly as if the user had pressed any other key. */
export function withCancelableAsk(ui: TuiAskUi): { ui: TuiAskUi; cancelPending(): void } {
  let pending: ((k: string) => void) | null = null;
  const wrapped: TuiAskUi = {
    showCard: (card, risk) => ui.showCard(card, risk),
    hideCard: () => ui.hideCard(),
    onKey(handler) {
      pending = handler;
      const unsubscribe = ui.onKey(handler);
      return () => {
        if (pending === handler) pending = null;
        unsubscribe();
      };
    },
  };
  return { ui: wrapped, cancelPending: () => pending?.("\x03") };
}

/** Every /model, /approve, /session, /escalate output line, and every
 * command-router error, lands here — one Text child per line (never one Text
 * per multi-line block: pi-tui's Text word-wraps a single string as one
 * paragraph, so embedded "\n" boundaries are preserved by splitting first
 * rather than trusting Text to treat them as line breaks). */
export function systemLine(tui: TUI, s: string): void {
  for (const line of sanitize(s).split("\n")) {
    if (line.length > 0) tui.addChild(new Text(line));
  }
  tui.requestRender();
}

/** Adapts pi-tui's callback-shaped Editor.onSubmit into the AsyncIterable<string>
 * runTuiMainLoop (and runRepl, for the plain REPL) both consume. Mirrors
 * cli.ts's own readline -> AsyncGenerator adapter. Overwrites `onSubmit` —
 * callers must not also assign it. */
export function adaptEditorToLines(editor: Editor): AsyncGenerator<string> {
  const queue: string[] = [];
  let waiter: ((v: string) => void) | null = null;
  editor.onSubmit = (text: string) => {
    editor.setText("");
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(text);
    } else {
      queue.push(text);
    }
  };
  return (async function* () {
    for (;;) {
      if (queue.length > 0) {
        yield queue.shift() as string;
        continue;
      }
      yield await new Promise<string>((resolve) => {
        waiter = resolve;
      });
    }
  })();
}
