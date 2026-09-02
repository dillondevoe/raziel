import type { Engine } from "../engine";
import type { Transcript } from "./transcript";
import type { Status } from "./status";

// M1c Task 5 — the TUI main loop's per-line processing, factored out of the
// real pi-tui wiring (src/tui/app.ts) the same way runRepl (src/cli.ts) is
// factored out of the plain REPL's readline wiring: this function only ever
// talks to an AsyncIterable<string> of submitted lines and the already-
// tested Transcript/Status/Engine surfaces, so it's fully testable with a
// scripted line generator + FakeProvider/ScriptedToolProvider — no real
// pi-tui Editor/TUI/Terminal required (app.ts supplies those at the edges:
// adapting the real Editor's onSubmit into an AsyncIterable, and adapting
// TuiSurface's ctrl-c routing into signalRef aborts).

export type TuiMainLoopOpts = {
  engineBox: { current: Engine };
  input: AsyncIterable<string>;
  transcript: Transcript;
  status: Status;
  signalRef: { current: AbortController | null };
  /** Same contract as runRepl's onCommand: /model, /approve, /session,
   * /escalate (and any future command) are tried before treating a line as
   * a prompt. "handled" lines never reach engine.send(). */
  onCommand?: (line: string) => "handled" | "not-command";
};

/** Runs until the input iterable ends or a bare "/quit" line arrives (same
 * two exit paths as runRepl). Event routing per the plan: `user_message` ->
 * Transcript.userLine (rendered from the EVENT engine.send() itself yields,
 * not written eagerly before the call, so a store-append failure that turns
 * the whole turn into an "error" stop never leaves a user line orphaned in
 * the transcript with no visible outcome); `assistant_delta` ->
 * beginAssistant (once per turn) + appendDelta; `approval_request` ->
 * toolCard's "request" phase (this is where risk becomes known — the
 * earlier `tool_request` event carries no risk, so it renders nothing on
 * its own); `tool_result` -> toolCard's "result" phase; `turn_end` ->
 * interruptMark on an interrupted stop, else endAssistant; `error` ->
 * errorLine. Status gets a coarse "streaming" activity for the whole turn,
 * a per-round "tool" activity while any tool_request is in flight, and
 * "idle" once the turn ends — see Status's own doc comment for why nothing
 * finer (token counts, tok/s) belongs here. */
export async function runTuiMainLoop(opts: TuiMainLoopOpts): Promise<void> {
  for await (const raw of opts.input) {
    const text = raw.trim();
    if (text === "/quit") return;
    if (text === "") continue;
    if (opts.onCommand && opts.onCommand(text) === "handled") continue;

    const ctl = new AbortController();
    opts.signalRef.current = ctl;
    opts.status.setActivity({ kind: "streaming", startedAt: Date.now() });

    const begun = new Set<string>();
    let round = 0;

    for await (const e of opts.engineBox.current.send(text, { signal: ctl.signal })) {
      switch (e.type) {
        case "user_message":
          opts.transcript.userLine(e.text);
          break;
        case "assistant_delta":
          if (!begun.has(e.turn)) {
            opts.transcript.beginAssistant(e.turn);
            begun.add(e.turn);
          }
          opts.transcript.appendDelta(e.turn, e.text);
          break;
        case "approval_request":
          round++;
          opts.status.setActivity({ kind: "tool", round });
          opts.transcript.toolCard({ tool: e.tool, risk: e.risk, phase: "request" });
          break;
        case "tool_result":
          opts.transcript.toolCard({ tool: e.tool, ok: e.ok, phase: "result", output: e.output });
          break;
        case "turn_end":
          if (e.stop === "interrupt") opts.transcript.interruptMark(e.turn);
          else opts.transcript.endAssistant(e.turn);
          break;
        case "error":
          opts.transcript.errorLine(e.message);
          break;
        default:
          break; // tool_request, approval_decision: no direct transcript line (see doc comment)
      }
    }

    opts.status.setActivity({ kind: "idle" });
    opts.signalRef.current = null;
  }
}
