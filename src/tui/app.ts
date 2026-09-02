import { Editor, type Terminal, type TUI } from "@earendil-works/pi-tui";
import { Engine } from "../engine";
import type { SessionStore } from "../session";
import type { ModelProfile } from "../profiles";
import type { ToolDeps } from "../engine_tool_call";
import type { BuiltinTool } from "../tools/files";
import type { Workspace } from "../tools/workspace";
import { sliceTools } from "../tools/registry";
import type { Provider } from "../provider";
import type { Rules } from "../rules";
import { ApprovalManager } from "../approvals";
import { createModelCommand, createApproveCommand, providerFor } from "../commands";
import { createSessionCommand, createEscalateCommand, type ProfileBox } from "./session_cmd";
import { Transcript } from "./transcript";
import { Status } from "./status";
import { makeTuiAsk, makeTuiAskUi } from "./approvals";
import { TuiSurface } from "./surface";
import { runTuiMainLoop } from "./loop";
import { EDITOR_THEME, withCancelableAsk, systemLine, adaptEditorToLines } from "./app_helpers";

// M1c Task 5 — the real pi-tui wiring: mounts Transcript/Status/Editor/the
// approval card onto ONE running TuiAltScreen (via TuiSurface's onReady
// hook — a small additive field on SurfaceDeps, see surface.ts) and hands
// the assembled pieces to runTuiMainLoop (src/tui/loop.ts, pure and
// separately tested). Small standalone pieces (the editor theme, the
// ctrl-c-cancellable ask wrapper, the systemLine/editor-input adapters) live
// in ./app_helpers to keep this file under the 200-line budget.
//
// Mounting choice: NOT setLayoutRoot — every component here is added via
// plain tui.addChild(), which leaves TuiAltScreen in its default "implicit
// document" mode. That mode already wraps `this.children` in its OWN
// internal ScrollView({follow:"end", primary:true}) (verified in
// tui-alt-screen.js) — the exact follow-at-end behavior the reference
// recommends, for free, with zero hand-rolled ScrollView/VStack. The other
// option (setLayoutRoot + an explicit ScrollView) was rejected because
// TuiAltScreen.getMountedRoots() returns EITHER `layoutRoot` OR
// `this.children`, never both — calling setLayoutRoot would silently stop
// rendering the approval card, which Task 3's makeTuiAskUi mounts via
// tui.addChild() and which this file must not modify.

export type TuiAppDeps = {
  /** Injectable; defaults to a real ProcessTerminal (TTY-only) when omitted. */
  terminal?: Terminal;
  /** Already-resolved provider for the STARTING profile (RAZIEL_FAKE=1 ->
   * FakeProvider, else providerForOrExit(profile) — same split main() makes
   * for the plain REPL). Subsequent /model, /session, /escalate swaps use
   * `providerForFn` (or providerFor) instead. */
  provider: Provider;
  store: SessionStore;
  profile: ModelProfile;
  registryFull: Map<string, BuiltinTool>;
  ws: Workspace;
  rules: Rules;
  rulesPath: string;
  providerForFn?: typeof providerFor;
};

export type TuiAppHandles = {
  tui: TUI;
  editor: Editor;
  transcript: Transcript;
  status: Status;
  engineBox: { current: Engine };
  /** Resolves once the main loop exits (a "/quit" line, or the loop's input
   * source ending) — distinct from ctrl-c-while-idle quitting, which never
   * touches the loop at all. */
  loopDone: Promise<void>;
};

/** Builds the app onto a TuiSurface without running it — split from
 * runTuiApp so tests can drive `handles` directly (submit lines via
 * `editor.onSubmit(...)`, inject raw approval-card keys via the stub
 * terminal) instead of only observing the black-box run-until-quit shape. */
export function createTuiApp(deps: TuiAppDeps): { surface: TuiSurface; ready: Promise<TuiAppHandles>; quit: Promise<void> } {
  let resolveReady!: (h: TuiAppHandles) => void;
  const ready = new Promise<TuiAppHandles>((resolve) => {
    resolveReady = resolve;
  });
  let resolveQuit!: () => void;
  const quit = new Promise<void>((resolve) => {
    resolveQuit = resolve;
  });

  const signalRef: { current: AbortController | null } = { current: null };
  let activeAskCancel: (() => void) | null = null;

  const surface = new TuiSurface({
    terminal: deps.terminal,
    onInterrupt: () => {
      // Requirement A: force-deny whatever approval card is open BEFORE (or
      // regardless of) aborting the turn signal — a low/medium-risk ask()
      // has no timer of its own, and TuiSurface's own ctrl-c input listener
      // consumes the raw byte before the card's onKey listener ever sees it
      // (registered later, and handleTerminalInput stops dispatch on the
      // first consume:true — see docs/pi-tui-reference.md §3), so without
      // this the ask() promise never resolves and the turn hangs forever.
      activeAskCancel?.();
      signalRef.current?.abort();
    },
    onQuit: () => resolveQuit(),
    isStreaming: () => signalRef.current !== null,
    onReady: (tui) => {
      const transcript = new Transcript(tui);
      const status = new Status(tui);
      status.setProfile(deps.profile, deps.provider.name);
      status.setSession(deps.store.id);

      const write = (s: string) => systemLine(tui, s);

      const cancelable = withCancelableAsk(makeTuiAskUi(tui));
      activeAskCancel = cancelable.cancelPending;
      const approvals = new ApprovalManager(deps.rules, { ask: makeTuiAsk(cancelable.ui), write }, deps.rulesPath);

      const toolsFull: ToolDeps = { registry: deps.registryFull, ws: deps.ws, approvals };
      const tools0: ToolDeps = {
        registry: sliceTools(deps.registryFull, deps.profile.maxToolSurface),
        ws: deps.ws,
        approvals,
      };
      const engineBox = {
        current: new Engine({ provider: deps.provider, store: deps.store, profile: deps.profile, tools: tools0 }),
      };
      const profileBox: ProfileBox = { current: deps.profile };

      const modelCmd = createModelCommand({
        engineBox,
        store: deps.store,
        initialProfile: deps.profile,
        write,
        providerForFn: deps.providerForFn,
        tools: toolsFull,
        onSwap: (info) => {
          profileBox.current = info.profile;
          status.setProfile(info.profile, info.providerName);
        },
      });
      const approveCmd = createApproveCommand({ rules: deps.rules, rulesPath: deps.rulesPath, write });
      const sessionCmd = createSessionCommand({
        engineBox,
        profileBox,
        tools: toolsFull,
        providerForFn: deps.providerForFn,
        write,
        onResumed: (info) => {
          status.setSession(info.sessionId);
          status.setProfile(profileBox.current, info.providerName);
        },
      });
      const escalateCmd = createEscalateCommand({ engineBox, profileBox, modelCmd, write });

      const onCommand = (line: string): "handled" | "not-command" =>
        modelCmd(line) === "handled"
          ? "handled"
          : approveCmd(line) === "handled"
            ? "handled"
            : sessionCmd(line) === "handled"
              ? "handled"
              : escalateCmd(line);

      const editor = new Editor(tui, EDITOR_THEME);
      tui.addChild(editor);
      tui.setFocus(editor);

      const loopDone = runTuiMainLoop({
        engineBox,
        input: adaptEditorToLines(editor),
        transcript,
        status,
        signalRef,
        onCommand,
      })
        .catch((err) => write(`raziel: ${err instanceof Error ? err.message : String(err)}`))
        .finally(resolveQuit);

      resolveReady({ tui, editor, transcript, status, engineBox, loopDone });
    },
  });

  return { surface, ready, quit };
}

/** Runs the TUI end to end: boot, run until quit (either a "/quit" line or
 * idle ctrl-c), then tear down. The real entry point cli.ts calls. */
export async function runTuiApp(deps: TuiAppDeps): Promise<void> {
  const { surface, quit } = createTuiApp(deps);
  surface.start();
  await quit;
  surface.stop();
}
