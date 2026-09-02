import { Engine } from "./engine";
import type { SessionStore } from "./session";
import { AnthropicProvider } from "./providers/anthropic";
import { OllamaProvider } from "./providers/ollama";
import { OpenAICompatProvider } from "./providers/openai_compat";
import type { Provider } from "./provider";
import { getProfile, listProfiles, type ModelProfile } from "./profiles";
import { sanitizeForTerminal } from "./term";
import type { ToolDeps } from "./engine_tool_call";
import { sliceTools } from "./tools/registry";
import type { Rules } from "./rules";
export { createAsk, type AskDeps } from "./ask";

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
 * SessionStore. Unknown id or provider error -> one-line error, no swap.
 *
 * `deps.tools`, when given, carries the FULL (unsliced) builtin registry —
 * every swap re-slices it to the NEW profile's maxToolSurface (I1, fix
 * round) rather than reusing whatever slice the previous profile had, so a
 * swap from a narrow-surface profile to a wider one regains the tools the
 * narrower profile didn't get, and vice versa. */
export function createModelCommand(deps: {
  engineBox: { current: Engine };
  store: SessionStore;
  initialProfile: ModelProfile;
  write: (s: string) => void;
  providerForFn?: typeof providerFor;
  tools?: ToolDeps;
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
    const tools: ToolDeps | undefined = deps.tools
      ? { registry: sliceTools(deps.tools.registry, next.maxToolSurface), ws: deps.tools.ws, approvals: deps.tools.approvals }
      : undefined;
    deps.engineBox.current = new Engine({ provider, store: deps.store, profile: next, tools });
    current = next;
    deps.write(statusLine(deps.store, next.model, provider.name));
    return "handled";
  };
}

/** The `/approve` REPL command: bare lists standing rules (numbered, with a
 * count — the session-visible counter R14 calls for); `/approve rm <n>`
 * removes the rule at that 1-indexed position and persists the change.
 * Listed rule text comes from disk (rules.json) and is sanitized before
 * hitting the terminal (I3, fix round) — a stored pattern is exactly as
 * untrusted as any other tool-adjacent text. */
export function createApproveCommand(deps: {
  rules: Rules;
  rulesPath: string;
  write: (s: string) => void;
}): (line: string) => "handled" | "not-command" {
  return (line: string) => {
    if (line !== "/approve" && !line.startsWith("/approve ")) return "not-command";
    const arg = line.slice("/approve".length).trim();

    if (arg === "") {
      deps.rules.list().forEach((r, i) => {
        deps.write(sanitizeForTerminal(`${i + 1}. ${r.tool}  ${r.pattern}`) + "\n");
      });
      deps.write(`${deps.rules.count()} standing rule(s)\n`);
      return "handled";
    }

    const m = /^rm (\d+)$/.exec(arg);
    if (m) {
      const idx = Number(m[1]);
      if (deps.rules.removeAt(idx)) {
        deps.rules.save(deps.rulesPath);
        deps.write(`removed rule ${idx}\n`);
      } else {
        deps.write(`raziel: no rule at index ${idx}\n`);
      }
      return "handled";
    }

    deps.write(`raziel: unknown /approve usage — try "/approve" or "/approve rm <n>"\n`);
    return "handled";
  };
}
