import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Engine } from "./engine";
import { SessionStore, razielHome } from "./session";
import { FakeProvider } from "./providers/fake";
import { renderBook, listSessions } from "./book";
import { defaultProfileId, getProfile, listProfiles, type ModelProfile } from "./profiles";
import { runDoctor } from "./doctor";
import { loadSystemPrompt } from "./system_prompt";
import { sanitizeForTerminal } from "./term";
import { providerForOrExit, createModelCommand, createApproveCommand, createScarCommand, createAsk, statusLine } from "./commands";
import { Workspace } from "./tools/workspace";
import { builtinTools, sliceTools } from "./tools/registry";
import { Rules } from "./rules";
import { ApprovalManager } from "./approvals";
import { wantsTui } from "./tui/surface";
import { runTuiApp } from "./tui/app";
import { createSessionCommand, createEscalateCommand, type ProfileBox, type StoreBox } from "./tui/session_cmd";
import { parseLaunchFlags, type LaunchFlags } from "./launch";

export { providerFor, createModelCommand } from "./commands";

const SIGIL = "   ╭───╮\n   │ ✧ │\n   ╰───╯\nraziel — keeper of the Book of Secrets\n";

export function makeSigintHandler(deps: {
  signalRef: { current: AbortController | null };
  isClosed: () => boolean;
  exit: (code: number) => void;
  write: (s: string) => void;
}): () => void {
  return () => {
    if (deps.signalRef.current) deps.signalRef.current.abort();
    else { deps.write("\nbye\n"); deps.exit(0); }
  };
}

export async function runRepl(opts: {
  engine: { current: Engine };
  input: AsyncIterable<string>;
  write: (s: string) => void;
  signalRef?: { current: AbortController | null };
  onCommand?: (line: string) => "handled" | "not-command";
}): Promise<void> {
  for await (const line of opts.input) {
    const text = line.trim();
    if (text === "/quit") return;
    if (text === "") continue;
    if (opts.onCommand && opts.onCommand(text) === "handled") continue;
    const ctl = new AbortController();
    if (opts.signalRef) opts.signalRef.current = ctl;
    for await (const e of opts.engine.current.send(text, { signal: ctl.signal })) {
      if (e.type === "assistant_delta") opts.write(sanitizeForTerminal(e.text));
      else if (e.type === "turn_end") opts.write("\n");
      else if (e.type === "error") opts.write(`\n[error] ${sanitizeForTerminal(e.message)}\n`);
    }
    if (opts.signalRef) opts.signalRef.current = null;
  }
}

/** Yields `prompt` as ONE input item, then everything from `live`. The plain
 * REPL is line-based, so a multi-line task piped on stdin arrives as one turn
 * per line (observed 2026-09-11: a six-paragraph mandate became five
 * fragments and the model asked what was cut off). `--prompt-file` reads the
 * file and feeds it through here, so a task is one turn however many lines it
 * has; approvals and later turns still come from the live input, in order. */
export async function* withLeadingPrompt(prompt: string, live: AsyncIterable<string>): AsyncGenerator<string> {
  if (prompt.length > 0) yield prompt;
  for await (const line of live) yield line;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Constructs a SessionStore, converting an invalid-id throw into a clean
 * one-line stderr message + process exit (no stack trace shown to the user). */
function openSessionOrExit(sessionId?: string): SessionStore {
  try {
    return new SessionStore(sessionId);
  } catch (err) {
    process.stderr.write(`raziel: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  if (process.argv[2] === "book") {
    const sessionId = process.argv[3];
    process.stdout.write(sessionId ? renderBook(openSessionOrExit(sessionId).replay()) : listSessions());
    return;
  }

  const profileId = arg("--profile") ?? defaultProfileId();
  const profile = getProfile(profileId);
  if (!profile) {
    const ids = listProfiles().map((p) => p.id).join(", ");
    process.stderr.write(`raziel: unknown profile ${JSON.stringify(profileId)}. Fix: --profile <one of: ${ids}>\n`);
    process.exit(1);
  }
  // --model overrides the selected profile's model name, for any provider:
  // a different Anthropic model, another `ollama pull`ed model, or whatever
  // an OpenAI-compatible server (RAZIEL_COMPAT_URL) serves.
  const modelOverride = arg("--model");
  const modelIsOverridden = modelOverride !== undefined;
  const model = modelOverride ?? profile.model;

  if (process.argv[2] === "doctor") {
    // `doctor` = every profile; `doctor --profile X [--model Y]` = just that one.
    const only = arg("--profile") !== undefined ? [{ ...profile, model }] : listProfiles();
    const r = await runDoctor(only, defaultProfileId());
    process.stdout.write(r.text);
    process.exit(r.ok ? 0 : 1);
  }

  const store = openSessionOrExit(arg("--session"));

  const write = (s: string) => process.stdout.write(s);

  // Headless launch surface (--grant / --allow-run / --max-rounds, or env). A
  // malformed value is a failed launch, printed once, before any provider or
  // session work -- never a run that silently denies everything.
  let launch: LaunchFlags;
  try {
    launch = parseLaunchFlags(process.argv.slice(2), process.env);
  } catch (err) {
    process.stderr.write(`raziel: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
  if (launch.grant) write(sanitizeForTerminal(`raziel ▷ unattended — ${launch.grant.describe()}`) + "\n");

  const ws = new Workspace(process.cwd());
  const rulesPath = join(razielHome(), "rules.json");
  const rules = Rules.load(rulesPath);
  if (rules.loadWarning) write(sanitizeForTerminal(`raziel: ${rules.loadWarning}`) + "\n");

  // `registryFull` carries the UNSLICED registry — createModelCommand (and,
  // in the TUI, createSessionCommand) re-slices it to each newly-selected
  // profile's maxToolSurface on every swap (I1, fix round).
  const registryFull = builtinTools();

  const provider = process.env.RAZIEL_FAKE === "1" ? new FakeProvider([["(fake reply)"]]) : providerForOrExit(profile);

  const signalRef: { current: AbortController | null } = { current: null };
  let rlClosed = false;
  const handleSigint = makeSigintHandler({
    signalRef,
    isClosed: () => rlClosed,
    exit: process.exit,
    write: (s) => process.stdout.write(s),
  });
  // Piped/non-TTY stdin never fires readline's "SIGINT" event, so this stays
  // registered even in TUI mode — raw mode there defeats interactive ctrl-c's
  // SIGINT translation (docs/pi-tui-reference.md §3), but a real out-of-band
  // SIGINT (e.g. a supervisor) is unaffected and this stays a second line of
  // defense for it, same as the reference recommends.
  process.on("SIGINT", handleSigint);

  if (wantsTui()) {
    // The raw `--model` override has
    // no first-class profile identity of its own — the TUI's /model,
    // /session, /escalate machinery is profile-shaped, so fold the override
    // into a derived profile object (spreading a frozen ModelProfile yields
    // a fresh, unfrozen one) instead of threading a parallel "raw model
    // string" concept through every TUI command.
    const tuiProfile: ModelProfile = modelIsOverridden ? { ...profile, model } : profile;
    await runTuiApp({ provider, store, profile: tuiProfile, registryFull, ws, rules, rulesPath });
    return;
  }

  // `inputIter` is assigned below once readline is wired up; createAsk's
  // readLine closure only runs once the REPL is actually running, by which
  // point it's set — this lets ask() and the REPL's own prompt loop pull
  // from the exact same input stream in sequence (never concurrently).
  let inputIter: AsyncGenerator<string> | undefined;
  const ask = createAsk({
    write,
    readLine: async () => {
      if (!inputIter) return undefined;
      const r = await inputIter.next();
      return r.done ? undefined : r.value;
    },
  });
  const approvals = new ApprovalManager(rules, { ask, write }, rulesPath, launch.grant);
  const toolsFull = { registry: registryFull, ws, approvals };
  const toolsInitial = { registry: sliceTools(registryFull, profile.maxToolSurface), ws, approvals };

  // A --model override keeps the profile's sampling and context budget (an
  // ollama num_ctx matters) and only swaps the model string; the selected
  // profile's persona applies either way.
  const engineProfile: ModelProfile = modelIsOverridden ? { ...profile, model } : profile;
  const engine = new Engine({ provider, store, profile: engineProfile, system: loadSystemPrompt(profile), tools: toolsInitial, maxRounds: launch.maxRounds });
  const engineBox: { current: Engine } = { current: engine };

  if (process.stdout.isTTY) write(SIGIL);
  write(statusLine(store, model, provider.name));
  const profileBox: ProfileBox = { current: profile };
  // I1: shared with createSessionCommand — a /session resume must survive a
  // later /model or /escalate swap in the plain REPL too, not just the TUI.
  const storeBox: StoreBox = { current: store };
  const modelCmd = createModelCommand({
    engineBox, store, storeBox, initialProfile: profile, write, tools: toolsFull, maxRounds: launch.maxRounds,
    onSwap: (info) => { profileBox.current = info.profile; },
  });
  const approveCmd = createApproveCommand({ rules, rulesPath, write });
  const sessionCmd = createSessionCommand({ engineBox, profileBox, storeBox, tools: toolsFull, write, maxRounds: launch.maxRounds });
  const escalateCmd = createEscalateCommand({ engineBox, profileBox, modelCmd, write });
  const scarCmd = createScarCommand({ store, storeBox, write });
  const onCommand = (line: string): "handled" | "not-command" =>
    modelCmd(line) === "handled" ? "handled"
    : approveCmd(line) === "handled" ? "handled"
    : sessionCmd(line) === "handled" ? "handled"
    : escalateCmd(line) === "handled" ? "handled"
    : scarCmd(line);

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "raziel> " });
  rl.on("close", () => { rlClosed = true; });
  // On a real TTY, readline intercepts Ctrl+C before process-level SIGINT ever fires.
  rl.on("SIGINT", () => { handleSigint(); if (!rlClosed) rl.prompt(); });
  rl.prompt();
  // Attach the readline iterator NOW, before the first turn runs. Node's
  // readline async iterator only buffers lines emitted after it exists; with
  // --prompt-file the first turn is long, and a piped stdin ("/quit" + EOF)
  // fires its line and close events during that turn. Attaching lazily lost
  // both, and the process sat forever after the turn (observed 2026-09-11 on
  // the first unattended ship: work done, commit made, no exit).
  const rlIter = rl[Symbol.asyncIterator]();
  const liveLines = (async function* () {
    for (;;) {
      const r = await rlIter.next();
      if (r.done) return;
      yield String(r.value);
      if (!rlClosed) rl.prompt();
    }
  })();
  // --prompt-file: the whole file is the first turn. Read up front so a
  // missing file fails the launch, not the first turn.
  const promptFile = arg("--prompt-file");
  let leading = "";
  if (promptFile !== undefined) {
    try { leading = readFileSync(promptFile, "utf8").replace(/\s+$/, ""); }
    catch (err) { process.stderr.write(`raziel: --prompt-file: ${err instanceof Error ? err.message : String(err)}\n`); process.exit(2); }
  }
  inputIter = withLeadingPrompt(leading, liveLines);
  await runRepl({ engine: engineBox, input: inputIter, write, signalRef, onCommand });
  rl.close();
}

/** Last line of defence: an unexpected failure is one `raziel:` line, not a
 * stack trace. RAZIEL_DEBUG=1 prints the stack for bug reports. */
export function crashLine(err: unknown, debug: boolean): string {
  if (debug && err instanceof Error && err.stack) return `raziel: ${err.stack}\n`;
  const msg = err instanceof Error ? err.message : String(err);
  return `raziel: ${msg} (set RAZIEL_DEBUG=1 for a stack trace)\n`;
}

if (import.meta.main) {
  try { await main(); } catch (err) {
    process.stderr.write(crashLine(err, process.env.RAZIEL_DEBUG === "1"));
    process.exit(1);
  }
}
