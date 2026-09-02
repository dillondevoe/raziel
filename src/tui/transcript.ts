import { Container, Markdown, Text, stripTerminalSequences, type MarkdownTheme } from "@earendil-works/pi-tui";
import { sanitizeForTerminal } from "../term";

// M1c Task 2 — the growing turn-history view. Mounted onto a caller-supplied
// pi-tui Container by Task 5 (which owns the actual TUI/ScrollView choice);
// this file only ever talks to the generic Container surface documented in
// docs/pi-tui-reference.md §4 (the base every layout primitive — and the TUI
// itself, via TuiBase — extends), so it works unchanged whether Task 5 mounts
// it directly under a TuiMainScreen (REPL-style, native scrollback — see the
// follow-at-end note below) or inside a ScrollView under TuiAltScreen.

const TOOL_OUTPUT_MAX = 400;

/** pi-tui ships zero colorizing (reference §6/§10 — chalk is a devDependency
 * only); every MarkdownTheme field is a plain passthrough here. Task 5 (or a
 * later theming pass) can swap this for a real ANSI theme without touching
 * the streaming/finalize logic below. */
const PLAIN_MARKDOWN_THEME: MarkdownTheme = {
  heading: (t) => t,
  link: (t) => t,
  linkUrl: (t) => t,
  code: (t) => t,
  codeBlock: (t) => t,
  codeBlockBorder: (t) => t,
  quote: (t) => t,
  quoteBorder: (t) => t,
  hr: (t) => t,
  listBullet: (t) => t,
  bold: (t) => t,
  italic: (t) => t,
  strikethrough: (t) => t,
  underline: (t) => t,
};

/** Binding: every string entering a component passes sanitizeForTerminal
 * (src/term.ts) THEN pi-tui's own stripTerminalSequences (reference §6 —
 * the exported, single-purpose ANSI sanitize seam). */
function sanitize(s: string): string {
  return stripTerminalSequences(sanitizeForTerminal(s));
}

/** Tool output is sanitized like everything else, then truncated to 400
 * chars — the full output stays in the session log/store; the transcript
 * only ever needs a readable preview. */
function truncateToolOutput(output: string): string {
  const clean = sanitize(output);
  // Cut by Unicode code point, not UTF-16 code unit: `Array.from(str)` splits
  // on code points, so a boundary can never land inside a surrogate pair.
  // A plain `clean.length`/`clean.slice()` cut is UTF-16-code-unit based and
  // will emit a lone high surrogate when an astral emoji straddles the cut —
  // malformed UTF-16 toward the terminal (fix-round I1, 2026-09-02). `N` in
  // the tail counts code points removed, matching the unit counted above.
  const codePoints = Array.from(clean);
  if (codePoints.length <= TOOL_OUTPUT_MAX) return clean;
  const extra = codePoints.length - TOOL_OUTPUT_MAX;
  return `${codePoints.slice(0, TOOL_OUTPUT_MAX).join("")}… (+${extra} chars, in session log)`;
}

export type ToolCardEvent = {
  tool: string;
  risk?: string;
  ok?: boolean;
  phase: "request" | "result";
  output?: string;
};

type OpenTurn = { text: Text; buffer: string };

/**
 * Transcript owns the rendered turn-history line-card stream. It never draws
 * pixels or holds a `TUI` reference itself — it only ever calls addChild /
 * children on a `Container` (constructor arg), which is exactly the parent
 * shape §4 of the reference documents (`Container implements Component`, the
 * base `Box`/`HStack`/`VStack`/`ScrollView` — and `TuiBase`, and therefore
 * `TuiMainScreen`/`TuiAltScreen` themselves — all extend).
 *
 * Streaming (reference §5, "reality wins" note): pi-tui ships NO
 * incremental/append text API — `Text.setText()`/`Markdown.setText()` always
 * fully replace the stored string. The idiomatic pattern the reference
 * documents for growing text is accumulate-client-side + `setText()` on every
 * chunk, relying on the *renderer's* differential redraw (§2: TuiMainScreen
 * "moves the cursor to the first changed line and rewrites only changed
 * lines onward") for the actual "no full-view rebuild" behavior — not any
 * patch method on the component. Transcript follows that pattern exactly:
 * `appendDelta` mutates the SAME `Text` instance in place (buffer += delta;
 * `text.setText(buffer)`) instead of adding a new child per delta, so the
 * Container's child list never changes shape mid-stream and only the one
 * open block's rendered lines differ frame to frame — which is what lets the
 * renderer's line-diff stay a diff instead of degrading into a full redraw
 * (verified behaviorally in tests/tui-transcript.test.ts via `TUI.fullRedraws`).
 *
 * Markdown-finalize (`endAssistant`) swaps that streaming `Text` for a real
 * `Markdown` render exactly once, at turn end — never per delta — because §5
 * also flags `Markdown.setText()` as a full re-parse of the whole string on
 * every call; doing that per delta would defeat the point above.
 */
export class Transcript {
  private readonly open = new Map<string, OpenTurn>();

  /** `requestRender`, when given, fires after EVERY mutation below (fix-round
   * C1: pi-tui only repaints on input/resize or an explicit requestRender()
   * call — reference:264 — nothing in this class used to trigger one, so a
   * scripted turn against a real terminal produced zero writes even though
   * children were changing underneath it). Optional and pi-tui-agnostic —
   * every existing single-arg call site/test is unaffected; app.ts is the
   * only caller that wires the real `tui.requestRender()`. */
  constructor(
    private readonly parent: Container,
    private readonly requestRender?: () => void,
  ) {}

  /** "› text" */
  userLine(text: string): void {
    this.parent.addChild(new Text(`› ${sanitize(text)}`, 0, 0));
    this.requestRender?.();
  }

  beginAssistant(turn: string): void {
    const text = new Text("", 0, 0);
    this.open.set(turn, { text, buffer: "" });
    this.parent.addChild(text);
    this.requestRender?.();
  }

  /** Streams into the open assistant block in place — see class doc. */
  appendDelta(turn: string, text: string): void {
    const entry = this.open.get(turn);
    if (!entry) return;
    entry.buffer += sanitize(text);
    entry.text.setText(entry.buffer);
    this.requestRender?.();
  }

  /** Finalize block: markdown-render the accumulated text (see class doc). */
  endAssistant(turn: string): void {
    this.finalize(turn);
    this.requestRender?.();
  }

  /** One compact line-card per tool event. Collapsible is not v1 scope —
   * compact is the v1 form. */
  toolCard(evt: ToolCardEvent): void {
    const tool = sanitize(evt.tool);
    const risk = evt.risk ? ` [${sanitize(evt.risk)}]` : "";
    if (evt.phase === "request") {
      this.parent.addChild(new Text(`→ ${tool}${risk}`, 0, 0));
      this.requestRender?.();
      return;
    }
    const mark = evt.ok === false ? "✗" : "✓";
    this.parent.addChild(new Text(`${mark} ${tool}${risk}`, 0, 0));
    if (evt.output !== undefined) {
      this.parent.addChild(new Text(`  ${truncateToolOutput(evt.output)}`, 0, 0));
    }
    this.requestRender?.();
  }

  errorLine(msg: string): void {
    this.parent.addChild(new Text(`! ${sanitize(msg)}`, 0, 0));
    this.requestRender?.();
  }

  /** Visible "· interrupted" marker. Also finalizes the turn's open block
   * (if any) the same way endAssistant does, since an interrupt ends the
   * turn without a separate endAssistant call. */
  interruptMark(turn: string): void {
    this.finalize(turn);
    this.parent.addChild(new Text("· interrupted", 0, 0));
    this.requestRender?.();
  }

  /** Swaps the open turn's streaming Text for a finalized Markdown render of
   * the same accumulated text, in the SAME slot in `parent.children` (a
   * public field on Container — reference §2/§4) rather than appending it at
   * the end. That matters because a tool card can legitimately land between
   * two deltas of the same open turn (the model calls a tool mid-generation);
   * appending the finalized block instead of swapping it in place would
   * reorder it after that card. No-op if the turn was never opened, or was
   * already finalized. */
  private finalize(turn: string): void {
    const entry = this.open.get(turn);
    if (!entry) return;
    this.open.delete(turn);
    const markdown = new Markdown(entry.buffer, 0, 0, PLAIN_MARKDOWN_THEME);
    const idx = this.parent.children.indexOf(entry.text);
    if (idx === -1) this.parent.addChild(markdown);
    else this.parent.children[idx] = markdown;
  }
}

// Follow-at-end note (reference §4's asymmetry): under a bare Container or
// TuiMainScreen there is no independently-scrollable region at all — content
// just accumulates, so the most-recently-added line is always the last line
// of `parent.render(width)` and is therefore always "visible" by definition.
// A bounded, app-owned scrolling viewport (ScrollView({ follow: "end" })
// under TuiAltScreen + setLayoutRoot) is Task 5's mounting choice, not
// something this component needs to implement itself.
