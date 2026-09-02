import { createInterface } from "node:readline";
import { Engine } from "./engine";
import { SessionStore } from "./session";
import { AnthropicProvider } from "./providers/anthropic";
import { FakeProvider } from "./providers/fake";
import { renderBook, listSessions } from "./book";
import { defaultProfileId, getProfile } from "./profiles";

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
  engine: Engine;
  input: AsyncIterable<string>;
  write: (s: string) => void;
  signalRef?: { current: AbortController | null };
}): Promise<void> {
  for await (const line of opts.input) {
    const text = line.trim();
    if (text === "/quit") return;
    if (text === "") continue;
    const ctl = new AbortController();
    if (opts.signalRef) opts.signalRef.current = ctl;
    for await (const e of opts.engine.send(text, { signal: ctl.signal })) {
      if (e.type === "assistant_delta") opts.write(e.text);
      else if (e.type === "turn_end") opts.write("\n");
      else if (e.type === "error") opts.write(`\n[error] ${e.message}\n`);
    }
    if (opts.signalRef) opts.signalRef.current = null;
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  if (process.argv[2] === "book") {
    const sessionId = process.argv[3];
    process.stdout.write(sessionId ? renderBook(new SessionStore(sessionId).replay()) : listSessions());
    return;
  }

  const store = new SessionStore(arg("--session"));
  // Full --profile / /model hot-swap wiring lands in a later M1a task; for now
  // the CLI's default model is resolved from the registry rather than duplicated here.
  const model = arg("--model") ?? getProfile(defaultProfileId())!.model;
  const provider = process.env.RAZIEL_FAKE === "1"
    ? new FakeProvider([["(fake reply)"]])
    : (() => {
      if (!process.env.ANTHROPIC_API_KEY) {
        process.stderr.write("raziel: ANTHROPIC_API_KEY not set (or use RAZIEL_FAKE=1)\n");
        process.exit(1);
      }
      return new AnthropicProvider();
    })();
  const engine = new Engine({ provider, store, model });

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

  if (process.stdout.isTTY) process.stdout.write(SIGIL);
  process.stdout.write(`raziel ▷ session ${store.id} · model ${model} · ${provider.name}\n`);
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "raziel> " });
  rl.on("close", () => { rlClosed = true; });
  // On a real TTY, readline intercepts Ctrl+C before process-level SIGINT ever fires.
  rl.on("SIGINT", () => { handleSigint(); if (!rlClosed) rl.prompt(); });
  rl.prompt();
  const input = (async function* () {
    for await (const line of rl) { yield String(line); if (!rlClosed) rl.prompt(); }
  })();
  await runRepl({ engine, input, write: (s) => process.stdout.write(s), signalRef });
  rl.close();
}

if (import.meta.main) await main();
