import { createInterface } from "node:readline";
import { join } from "node:path";
import { Engine } from "./engine";
import { SessionStore, razielHome } from "./session";
import { FakeProvider } from "./providers/fake";
import { renderBook, listSessions } from "./book";
import { defaultProfileId, getProfile } from "./profiles";
import { sanitizeForTerminal } from "./term";
import { providerForOrExit, createModelCommand, createApproveCommand, createAsk, statusLine } from "./commands";
import { Workspace } from "./tools/workspace";
import { builtinTools, sliceTools } from "./tools/registry";
import { Rules } from "./rules";
import { ApprovalManager } from "./approvals";
import { TuiSurface, wantsTui } from "./tui/surface";

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

/** Boots the minimal TUI shell (Task 1 of M1c) — alt-screen + ctrl-c routing,
 * no transcript/engine wiring yet (that's Task 5). Resolves once onQuit fires
 * (idle ctrl-c), after which the surface has already been torn down. */
async function runTuiShell(signalRef: { current: AbortController | null }): Promise<void> {
  let resolveQuit!: () => void;
  const quit = new Promise<void>((resolve) => { resolveQuit = resolve; });
  const surface = new TuiSurface({
    onInterrupt: () => signalRef.current?.abort(),
    onQuit: () => resolveQuit(),
    isStreaming: () => signalRef.current !== null,
  });
  surface.start();
  await quit;
  surface.stop();
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

  const store = openSessionOrExit(arg("--session"));

  const profileId = arg("--profile") ?? defaultProfileId();
  const profile = getProfile(profileId);
  if (!profile) {
    process.stderr.write(`raziel: unknown profile ${JSON.stringify(profileId)}\n`);
    process.exit(1);
  }
  // --model is a raw-model override (M0-smoke back-compat), anthropic-only —
  // --profile wins whenever both are given.
  const modelOverride = arg("--model");
  const modelIsOverridden = profile.provider === "anthropic" && modelOverride !== undefined;
  const model = modelIsOverridden ? modelOverride : profile.model;

  const write = (s: string) => process.stdout.write(s);

  const ws = new Workspace(process.cwd());
  const rulesPath = join(razielHome(), "rules.json");
  const rules = Rules.load(rulesPath);
  if (rules.loadWarning) write(sanitizeForTerminal(`raziel: ${rules.loadWarning}`) + "\n");

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
  const approvals = new ApprovalManager(rules, { ask, write }, rulesPath);
  // `toolsFull` carries the UNSLICED registry — createModelCommand re-slices
  // it to each newly-selected profile's maxToolSurface on every /model swap
  // (I1, fix round). `toolsInitial` is the slice for the profile main()
  // starts on, so the very first Engine already respects it too.
  const registryFull = builtinTools();
  const toolsFull = { registry: registryFull, ws, approvals };
  const toolsInitial = { registry: sliceTools(registryFull, profile.maxToolSurface), ws, approvals };

  const provider = process.env.RAZIEL_FAKE === "1" ? new FakeProvider([["(fake reply)"]]) : providerForOrExit(profile);
  const engine = modelIsOverridden
    ? new Engine({ provider, store, model, tools: toolsInitial })
    : new Engine({ provider, store, profile, tools: toolsInitial });
  const engineBox: { current: Engine } = { current: engine };

  const signalRef: { current: AbortController | null } = { current: null };
  let rlClosed = false;
  const handleSigint = makeSigintHandler({
    signalRef,
    isClosed: () => rlClosed,
    exit: process.exit,
    write: (s) => process.stdout.write(s),
  });
  // Piped/non-TTY stdin never fires readline's "SIGINT" event, so this stays registered.
  process.on("SIGINT", handleSigint);

  if (wantsTui()) {
    await runTuiShell(signalRef);
    return;
  }

  if (process.stdout.isTTY) write(SIGIL);
  write(statusLine(store, model, provider.name));
  const modelCmd = createModelCommand({ engineBox, store, initialProfile: profile, write, tools: toolsFull });
  const approveCmd = createApproveCommand({ rules, rulesPath, write });
  const onCommand = (line: string): "handled" | "not-command" =>
    modelCmd(line) === "handled" ? "handled" : approveCmd(line);

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "raziel> " });
  rl.on("close", () => { rlClosed = true; });
  // On a real TTY, readline intercepts Ctrl+C before process-level SIGINT ever fires.
  rl.on("SIGINT", () => { handleSigint(); if (!rlClosed) rl.prompt(); });
  rl.prompt();
  inputIter = (async function* () {
    for await (const line of rl) { yield String(line); if (!rlClosed) rl.prompt(); }
  })();
  await runRepl({ engine: engineBox, input: inputIter, write, signalRef, onCommand });
  rl.close();
}

if (import.meta.main) await main();
