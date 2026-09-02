import { createInterface } from "node:readline";
import { Engine } from "./engine";
import { SessionStore } from "./session";
import { AnthropicProvider } from "./providers/anthropic";
import { OllamaProvider } from "./providers/ollama";
import { OpenAICompatProvider } from "./providers/openai_compat";
import { FakeProvider } from "./providers/fake";
import type { Provider } from "./provider";
import { renderBook, listSessions } from "./book";
import { defaultProfileId, getProfile, listProfiles, type ModelProfile } from "./profiles";
import { sanitizeForTerminal } from "./term";

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

/** Builds the Provider for a profile. `"anthropic"` keeps the pre-M1a key
 * guard (fail fast, clean message, no stack trace); `"ollama"` takes an
 * optional injected fetch for tests; `"openai-compat"` reads its API key
 * from RAZIEL_COMPAT_KEY (undefined is fine for keyless local servers). */
export function providerFor(p: ModelProfile, fetchImpl?: typeof fetch): Provider {
  switch (p.provider) {
    case "anthropic": {
      if (!process.env.ANTHROPIC_API_KEY) {
        process.stderr.write("raziel: ANTHROPIC_API_KEY not set (or use RAZIEL_FAKE=1)\n");
        process.exit(1);
      }
      return new AnthropicProvider();
    }
    case "ollama":
      return new OllamaProvider({ baseUrl: p.baseUrl, fetchImpl });
    case "openai-compat":
      return new OpenAICompatProvider({ baseUrl: p.baseUrl!, apiKey: process.env.RAZIEL_COMPAT_KEY });
  }
}

/** Builds an Engine from a profile, threading its sampling params through. */
function engineForProfile(profile: ModelProfile, store: SessionStore, provider: Provider): Engine {
  return new Engine({ provider, store, profile });
}

function statusLine(store: SessionStore, model: string, providerName: string): string {
  return `raziel ▷ session ${store.id} · model ${model} · ${providerName}\n`;
}

/** The real /model REPL command, wired into runRepl's onCommand hook.
 * Bare `/model` lists the registry (marking the current profile); `/model
 * <id>` rebuilds the Engine over the SAME SessionStore — the event log is
 * the continuity, a mid-session swap is legal by design. Unknown id ->
 * one-line error, no crash, no swap. */
export function createModelCommand(deps: {
  engineBox: { current: Engine };
  store: SessionStore;
  initialProfile: ModelProfile;
  write: (s: string) => void;
  providerForFn?: typeof providerFor;
}): (line: string) => "handled" | "not-command" {
  let current = deps.initialProfile;
  const buildProvider = deps.providerForFn ?? providerFor;

  return (line: string) => {
    if (line !== "/model" && !line.startsWith("/model ")) return "not-command";
    const arg = line.slice("/model".length).trim();

    if (arg === "") {
      for (const p of listProfiles()) {
        deps.write(`${p.id === current.id ? "* " : "  "}${p.id}  ${p.provider}  ${p.model}\n`);
      }
      return "handled";
    }

    const next = getProfile(arg);
    if (!next) {
      deps.write(`raziel: unknown profile ${JSON.stringify(arg)}\n`);
      return "handled";
    }

    const provider = buildProvider(next);
    deps.engineBox.current = engineForProfile(next, deps.store, provider);
    current = next;
    deps.write(statusLine(deps.store, next.model, provider.name));
    return "handled";
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
  // --model is a raw-model override, back-compat for M0 smokes, and only
  // applies on the anthropic path — --profile wins whenever both are given
  // (a non-anthropic profile's own model/provider are never overridden).
  const modelOverride = arg("--model");
  const modelIsOverridden = profile.provider === "anthropic" && modelOverride !== undefined;
  const model = modelIsOverridden ? modelOverride : profile.model;

  const provider = process.env.RAZIEL_FAKE === "1" ? new FakeProvider([["(fake reply)"]]) : providerFor(profile);
  const engine = modelIsOverridden
    ? new Engine({ provider, store, model })
    : new Engine({ provider, store, profile });
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

  const write = (s: string) => process.stdout.write(s);
  if (process.stdout.isTTY) write(SIGIL);
  write(statusLine(store, model, provider.name));
  const onCommand = createModelCommand({ engineBox, store, initialProfile: profile, write });

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "raziel> " });
  rl.on("close", () => { rlClosed = true; });
  // On a real TTY, readline intercepts Ctrl+C before process-level SIGINT ever fires.
  rl.on("SIGINT", () => { handleSigint(); if (!rlClosed) rl.prompt(); });
  rl.prompt();
  const input = (async function* () {
    for await (const line of rl) { yield String(line); if (!rlClosed) rl.prompt(); }
  })();
  await runRepl({ engine: engineBox, input, write, signalRef, onCommand });
  rl.close();
}

if (import.meta.main) await main();
