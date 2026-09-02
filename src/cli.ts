import { createInterface } from "node:readline";
import { Engine } from "./engine";
import { SessionStore } from "./session";
import { AnthropicProvider } from "./providers/anthropic";
import { FakeProvider } from "./providers/fake";

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
  const store = new SessionStore(arg("--session"));
  const model = arg("--model") ?? "claude-sonnet-5";
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
  process.on("SIGINT", () => {
    if (signalRef.current) signalRef.current.abort();
    else { process.stdout.write("\nbye\n"); process.exit(0); }
  });

  process.stdout.write(`raziel ▷ session ${store.id} · model ${model} · ${provider.name}\n`);
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "raziel> " });
  rl.prompt();
  const input = (async function* () {
    for await (const line of rl) { yield String(line); rl.prompt(); }
  })();
  await runRepl({ engine, input, write: (s) => process.stdout.write(s), signalRef });
  rl.close();
}

if (import.meta.main) await main();
