import {
  Key,
  ProcessTerminal,
  Text,
  TuiAltScreen,
  matchesKey,
  type Terminal,
  type TUI,
} from "@earendil-works/pi-tui";

// M1c Task 1 — TUI lifecycle shell. Full transcript/session/engine wiring is
// Task 5; this is intentionally just the pi-tui alt-screen lifecycle plus
// ctrl-c routing and crash-safe terminal restore. See docs/pi-tui-reference.md
// for the API this traces to (§3 SIGINT/raw-mode, §7 lifecycle, §8 the
// headless stub-Terminal pattern this file's tests follow).

/** Dependencies TuiSurface needs from the surrounding CLI — injected so the
 * lifecycle shell is testable headlessly against a stub Terminal (no PTY). */
export type SurfaceDeps = {
  /** Injectable; defaults to a real ProcessTerminal (TTY-only) when omitted. */
  terminal?: Terminal;
  /** Fires the active turn's AbortController — the same abort path the
   * process-level SIGINT handler uses (per reference §3: raw mode silently
   * defeats ctrl-c's SIGINT translation, so this is the only way to see it). */
  onInterrupt(): void;
  /** Clean shutdown request — idle ctrl-c, or a future /quit-equivalent. */
  onQuit(): void;
  /** Whether a turn is in flight; decides ctrl-c's interrupt-vs-quit split. */
  isStreaming(): boolean;
};

const BANNER = "raziel — TUI shell (minimal)\nCtrl+C: interrupt a running turn, or quit when idle.\n";

/** Owns the pi-tui alt-screen lifecycle: alt-screen entry/exit (and, via the
 * real ProcessTerminal, raw mode), ctrl-c routing, and crash-safe restore.
 * `start()`/`stop()` are both idempotent. */
export class TuiSurface {
  private tui: TUI | null = null;
  private removeInputListener: (() => void) | null = null;
  private removeCrashHandlers: (() => void) | null = null;

  constructor(private readonly deps: SurfaceDeps) {}

  get running(): boolean {
    return this.tui !== null;
  }

  /** Alt-screen up, raw mode on (inside the Terminal), ctrl-c routing live,
   * crash handlers installed. A second call while already running is a no-op. */
  start(): void {
    if (this.tui) return;
    const terminal = this.deps.terminal ?? new ProcessTerminal();
    const tui = new TuiAltScreen(terminal);
    tui.addChild(new Text(BANNER));
    this.tui = tui;
    this.installCrashHandlers();
    this.removeInputListener = tui.addInputListener((data) => {
      if (!matchesKey(data, Key.ctrl("c"))) return undefined;
      if (this.deps.isStreaming()) this.deps.onInterrupt();
      else this.deps.onQuit();
      return { consume: true };
    });
    tui.start();
  }

  /** Full terminal restore. Safe to call twice, and safe if never started. */
  stop(): void {
    if (!this.tui) return;
    const tui = this.tui;
    this.tui = null;
    this.removeInputListener?.();
    this.removeInputListener = null;
    this.removeCrashHandlers?.();
    this.removeCrashHandlers = null;
    tui.stop();
  }

  /** Installed once per running instance (guarded by removeCrashHandlers being
   * set); torn down in stop() so a crashed/never-run process never leaks
   * process-level listeners across TuiSurface instances (e.g. across tests). */
  private installCrashHandlers(): void {
    if (this.removeCrashHandlers) return;
    const onCrash = (err: unknown): void => {
      this.stop();
      const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
      process.stderr.write(`raziel: fatal — ${detail}\n`);
      process.exit(1);
    };
    const onExit = (): void => {
      this.stop();
    };
    process.on("uncaughtException", onCrash);
    process.on("unhandledRejection", onCrash);
    process.on("exit", onExit);
    this.removeCrashHandlers = () => {
      process.off("uncaughtException", onCrash);
      process.off("unhandledRejection", onCrash);
      process.off("exit", onExit);
    };
  }
}

/** TUI only makes sense on a real interactive terminal; RAZIEL_PLAIN is an
 * explicit escape hatch back to the plain REPL for either side of a pipe. */
export function wantsTui(): boolean {
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY) && !process.env.RAZIEL_PLAIN;
}
