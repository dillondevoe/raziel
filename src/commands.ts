import { Engine } from "./engine";
import type { SessionStore } from "./session";
import { AnthropicProvider } from "./providers/anthropic";
import { OllamaProvider } from "./providers/ollama";
import { OpenAICompatProvider } from "./providers/openai_compat";
import type { Provider } from "./provider";
import { getProfile, listProfiles, type ModelProfile } from "./profiles";
import { sanitizeForTerminal } from "./term";

const MISSING_ANTHROPIC_KEY_MESSAGE = "ANTHROPIC_API_KEY not set (or use RAZIEL_FAKE=1)";

/** Pure factory, one switch per provider kind. `"anthropic"` THROWS (never
 * exits) on a missing key — a `/model` swap must report it and keep the
 * current engine alive; startup fail-fast lives in providerForOrExit below. */
export function providerFor(p: ModelProfile, fetchImpl?: typeof fetch): Provider {
  switch (p.provider) {
    case "anthropic": {
      if (!process.env.ANTHROPIC_API_KEY) throw new Error(MISSING_ANTHROPIC_KEY_MESSAGE);
      return new AnthropicProvider();
    }
    case "ollama":
      return new OllamaProvider({ baseUrl: p.baseUrl, fetchImpl });
    case "openai-compat": {
      if (!p.baseUrl) throw new Error(`profile ${p.id} missing baseUrl`);
      return new OpenAICompatProvider({ baseUrl: p.baseUrl, apiKey: process.env.RAZIEL_COMPAT_KEY });
    }
  }
}

/** Startup call site: providerFor's error becomes a clean one-line stderr
 * message + process exit, same shape as openSessionOrExit in cli.ts. */
export function providerForOrExit(profile: ModelProfile): Provider {
  try {
    return providerFor(profile);
  } catch (err) {
    process.stderr.write(`raziel: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

export function statusLine(store: SessionStore, model: string, providerName: string): string {
  return `raziel ▷ session ${store.id} · model ${model} · ${providerName}\n`;
}

/** The real /model REPL command. Bare `/model` lists the registry (marking
 * the current profile); `/model <id>` rebuilds the Engine over the SAME
 * SessionStore. Unknown id or provider error -> one-line error, no swap. */
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

    let provider: Provider;
    try {
      provider = buildProvider(next);
    } catch (err) {
      // Same UX as the unknown-id path: one-line error, no swap, no crash.
      deps.write(sanitizeForTerminal(`raziel: ${err instanceof Error ? err.message : String(err)}\n`));
      return "handled";
    }
    deps.engineBox.current = new Engine({ provider, store: deps.store, profile: next });
    current = next;
    deps.write(statusLine(deps.store, next.model, provider.name));
    return "handled";
  };
}
