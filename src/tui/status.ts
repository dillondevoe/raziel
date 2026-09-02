import { type Component, Container, stripTerminalSequences } from "@earendil-works/pi-tui";
import type { ModelProfile } from "../profiles";
import { sanitizeForTerminal } from "../term";
import { MAX_ROUNDS } from "../engine_tools";

// M1c Task 4 — the truthful statusline component. Holds known-true state only:
// profile, session id, and current activity kind (idle/streaming/tool). NO
// estimated/computed numbers (token counts, cost, tok/s) — see M1d deferral
// forbidding such numbers. "streaming Ns" renders elapsed seconds from
// startedAt, which is measured ground truth, not estimated.
//
// Implements the pi-tui Component interface. Mounted onto a caller-supplied
// Container (same pattern as Transcript); never holds a TUI reference. For
// streaming activities, render() recalculates elapsed seconds on every call
// (no cache) so time is always fresh.
//
// Task 5 fix-round (requirement B): "tool round N/8" used to hardcode the
// round cap as a second literal duplicating engine_tools.ts's own MAX_ROUNDS
// — imported here instead so the two can never drift apart.
//
// Task 5 final-fix-round (M1): same belt-and-braces double-strip
// transcript.ts's `sanitize()` applies to every string that reaches a
// pi-tui component — sanitizeForTerminal (src/term.ts) THEN pi-tui's own
// stripTerminalSequences (reference §6) — applied here too, since the
// session id setSession() accepts is not guaranteed to be a
// containment-validated SessionStore id (Status's own API takes any
// string).

/** See the M1 note above: the same two-layer strip transcript.ts uses. */
function sanitize(s: string): string {
  return stripTerminalSequences(sanitizeForTerminal(s));
}

type Activity =
  | { kind: "idle" }
  | { kind: "streaming"; startedAt: number }
  | { kind: "tool"; round: number };

class StatusRenderComponent implements Component {
  constructor(
    private status: Status
  ) {}

  render(width: number): string[] {
    return this.status.renderLine(width);
  }

  invalidate(): void {
    this.status.invalidateCache();
  }
}

export class Status {
  private profile: ModelProfile | undefined;
  // Defaults to "" (never rendered until setProfile is called, since the
  // profile-line segment is gated on `this.profile` being set) rather than
  // to profile.provider, so a caller that never passes an explicit name
  // still renders SOMETHING sane once a profile is set (see setProfile).
  private providerName: string = "";
  private sessionId: string = "";
  private activity: Activity = { kind: "idle" };
  private now: () => number = () => Date.now();
  private cachedLine: string | undefined;
  private cachedWidth: number | undefined;
  private renderComponent: StatusRenderComponent;

  /** `requestRender`, when given, fires after every setter below (fix-round
   * C1: nothing here used to trigger a repaint, so "streaming Ns" never
   * actually reached the terminal as it ticked — see Transcript's matching
   * doc comment for the full reference:264 citation). Optional and
   * pi-tui-agnostic; app.ts wires the real `tui.requestRender()`. */
  constructor(
    parent: Container,
    private readonly requestRender?: () => void,
  ) {
    this.renderComponent = new StatusRenderComponent(this);
    parent.addChild(this.renderComponent);
  }

  /** Requirement C: the rendered provider name must reflect the LIVE
   * provider instance actually in use (e.g. FakeProvider under
   * RAZIEL_FAKE=1, which never equals `profile.provider`) — never the
   * profile's static declared provider kind. `providerName` is an explicit,
   * optional second argument for exactly that; when omitted it falls back
   * to `p.provider` so every pre-existing single-arg call site (real REPL
   * bootstrap before this fix, and every existing test) keeps rendering
   * the same text as before. */
  setProfile(p: ModelProfile, providerName?: string): void {
    this.profile = p;
    this.providerName = providerName ?? p.provider;
    this.invalidateCache();
    this.requestRender?.();
  }

  setSession(id: string): void {
    this.sessionId = id;
    this.invalidateCache();
    this.requestRender?.();
  }

  setActivity(
    a: Activity,
    now?: () => number
  ): void {
    this.activity = a;
    if (now) {
      this.now = now;
    }
    this.invalidateCache();
    this.requestRender?.();
  }

  invalidate(): void {
    this.invalidateCache();
  }

  invalidateCache(): void {
    this.cachedLine = undefined;
    this.cachedWidth = undefined;
  }

  renderLine(width: number): string[] {
    // For streaming, never cache because elapsed time changes on every call.
    // For other activities, cache based on width since they don't change.
    const isStreaming = this.activity.kind === "streaming";
    if (!isStreaming && this.cachedLine !== undefined && this.cachedWidth === width) {
      return [this.cachedLine];
    }

    // Requirement D, segment 1: join with " · " between only the parts that
    // actually exist, instead of unconditionally prepending " · " after an
    // optional profile segment. The old code always started the line with
    // the profile segment's OWN "· " separator baked into its string, so an
    // unset profile (Status constructed but setProfile never called — e.g.
    // the brief instant between mount and the first setProfile call) left a
    // stray leading "· " with nothing before it. Building an array and
    // `.join(" · ")`-ing it can never produce a leading separator, set or not.
    const parts: string[] = [];

    if (this.profile) {
      parts.push(`${this.profile.id} (${this.profile.model}) · ${this.providerName}`);
    }

    // Requirement D, segment 2: sanitize the FULL session id first, THEN
    // truncate the already-clean result to 8 chars — not the reverse. An id
    // containing an OSC/CSI escape sequence has its terminator well past the
    // first 8 raw characters; truncating first can slice the sequence in
    // half, leaving the sanitizer (no terminator left in the truncated
    // fragment to match) unable to remove the now-headless escape payload —
    // visible garbage reaches the terminal instead of a clean 8-char id.
    // Sanitizing the whole string first always removes the complete
    // sequence regardless of where the 8-char cut later falls.
    const cleanId = sanitize(this.sessionId);
    parts.push(`session ${cleanId.slice(0, 8)}`);

    if (this.activity.kind === "tool") {
      parts.push(`tool round ${this.activity.round}/${MAX_ROUNDS}`);
    } else if (this.activity.kind === "streaming") {
      const elapsed = Math.floor((this.now() - this.activity.startedAt) / 1000);
      parts.push(`streaming ${elapsed}s`);
    } else {
      parts.push("idle");
    }

    let line = parts.join(" · ");

    if (!isStreaming) {
      this.cachedLine = line;
      this.cachedWidth = width;
    }

    return [line];
  }
}
