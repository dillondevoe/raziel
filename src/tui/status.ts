import { type Component, Container } from "@earendil-works/pi-tui";
import type { ModelProfile } from "../profiles";
import { sanitizeForTerminal } from "../term";

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
  private sessionId: string = "";
  private activity: Activity = { kind: "idle" };
  private now: () => number = () => Date.now();
  private cachedLine: string | undefined;
  private cachedWidth: number | undefined;
  private renderComponent: StatusRenderComponent;

  constructor(parent: Container) {
    this.renderComponent = new StatusRenderComponent(this);
    parent.addChild(this.renderComponent);
  }

  setProfile(p: ModelProfile): void {
    this.profile = p;
    this.invalidateCache();
  }

  setSession(id: string): void {
    this.sessionId = id;
    this.invalidateCache();
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

    let line = "";

    if (this.profile) {
      line += `${this.profile.id} (${this.profile.model}) · ${this.profile.provider}`;
    }

    const id8 = this.sessionId.slice(0, 8);
    line += ` · session ${sanitizeForTerminal(id8)}`;

    line += " · ";
    if (this.activity.kind === "tool") {
      line += `tool round ${this.activity.round}/8`;
    } else if (this.activity.kind === "streaming") {
      const elapsed = Math.floor((this.now() - this.activity.startedAt) / 1000);
      line += `streaming ${elapsed}s`;
    } else {
      line += "idle";
    }

    if (!isStreaming) {
      this.cachedLine = line;
      this.cachedWidth = width;
    }

    return [line];
  }
}
