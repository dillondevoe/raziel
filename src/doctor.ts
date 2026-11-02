import type { Provider } from "./provider";
import type { ModelProfile } from "./profiles";
import { isOAuthToken, OAUTH_REFUSAL } from "./providers/anthropic";
import { sanitizeForTerminal } from "./term";

/** Day-one diagnostics: one plain-English line naming the problem and the
 * exact fix (an env var, a flag, a command), never a stack trace. Used two
 * ways: `explainProviderError` rewrites a failed turn's error, and
 * `runDoctor` (`bun run src/cli.ts doctor`) checks every profile up front with free
 * listing calls -- GET models / tags -- so it spends no tokens. */

type Env = Record<string, string | undefined>;
const DEFAULT_ANTHROPIC_URL = "https://api.anthropic.com";
const ANTHROPIC_KEY_FIX = "export ANTHROPIC_API_KEY=sk-ant-api... (create a key at console.anthropic.com)";

/** The endpoint a profile actually talks to, after the env overrides providerFor honours. */
export function endpointFor(p: ModelProfile, env: Env = process.env): string {
  if (p.provider === "anthropic") return env.ANTHROPIC_BASE_URL ?? DEFAULT_ANTHROPIC_URL;
  if (p.provider === "ollama") return env.RAZIEL_OLLAMA_URL ?? p.baseUrl ?? "http://127.0.0.1:11434";
  if (p.provider === "openai-compat") return env.RAZIEL_COMPAT_URL ?? p.baseUrl ?? "";
  return p.baseUrl ?? "";
}

function keyEnvFor(p: ModelProfile): string | undefined {
  return p.provider === "anthropic" ? "ANTHROPIC_API_KEY" : p.provider === "ollama" ? undefined : p.apiKeyEnv ?? "RAZIEL_COMPAT_KEY";
}

type Kind = "unreachable" | "auth" | "no-model";

function hint(kind: Kind, p: ModelProfile, model: string, url: string, models?: string[]): string {
  const keyEnv = keyEnvFor(p);
  const pick = models && models.length > 0 ? ` (it serves: ${models.slice(0, 5).join(", ")})` : "";
  switch (p.provider) {
    case "anthropic":
      if (kind === "unreachable") return `cannot reach Anthropic at ${url}. Fix: check your network or proxy; if you set ANTHROPIC_BASE_URL, check it.`;
      if (kind === "auth") return `Anthropic rejected the key in ANTHROPIC_API_KEY. Fix: ${ANTHROPIC_KEY_FIX}.`;
      return `Anthropic has no model "${model}". Fix: pass --model <model id>${pick}.`;
    case "ollama":
      if (kind === "unreachable") return `ollama is not running at ${url}. Fix: start it with \`ollama serve\` (install from ollama.com), or set RAZIEL_OLLAMA_URL=http://<host>:11434 if it runs elsewhere.`;
      if (kind === "auth") return `ollama at ${url} refused the request. Fix: check RAZIEL_OLLAMA_URL points at an ollama server.`;
      return `ollama has no model "${model}". Fix: \`ollama pull ${model}\`.`;
    default: {
      const urlFix = p.provider === "openai-compat" ? "set RAZIEL_COMPAT_URL=<base url ending in /v1>" : "check the profile's baseUrl";
      if (kind === "unreachable") return `nothing answered at ${url}. Fix: start the server, or ${urlFix}.`;
      if (kind === "auth") return `${url} rejected the key in ${keyEnv}. Fix: export ${keyEnv}=<a key for that endpoint>.`;
      return `${url} has no model "${model}". Fix: pass --model <name>${pick}, or ${urlFix}.`;
    }
  }
}

function statusOf(err: unknown, msg: string): number | undefined {
  const s = (err as { status?: unknown } | null)?.status;
  if (typeof s === "number") return s;
  const m = /^(\d{3})[: ]|\((\d{3})\)|\/api\/chat (\d{3})/.exec(msg);
  return m ? Number(m[1] ?? m[2] ?? m[3]) : undefined;
}

function isConnectionError(err: unknown, msg: string): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = String(e?.code ?? e?.cause?.code ?? "");
  return /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|ETIMEDOUT/.test(code)
    || /Connection error|Unable to connect|ECONNREFUSED|ENOTFOUND|fetch failed/i.test(msg);
}

/** Rewrite a provider error into the plain-English line for the cases a new
 * user hits (unreachable, bad key, unknown model); anything else passes
 * through unchanged so no detail is lost. */
export function explainProviderError(err: unknown, p: ModelProfile, model: string, env: Env = process.env): string {
  const msg = err instanceof Error ? err.message : String(err);
  const url = endpointFor(p, env);
  if (isConnectionError(err, msg)) return hint("unreachable", p, model, url);
  const status = statusOf(err, msg);
  if (status === 401 || status === 403) return hint("auth", p, model, url);
  if (status === 404) return hint("no-model", p, model, url);
  return msg;
}

/** Route `provider.stream` errors through explainProviderError. Patches the
 * instance (not a wrapper object) so callers keep the concrete class. */
export function withPlainErrors<P extends Provider>(provider: P, p: ModelProfile): P {
  const inner = provider.stream.bind(provider);
  provider.stream = async function* (opts) {
    try { yield* inner(opts); } catch (err) {
      if (opts.signal?.aborted) throw err;
      throw new Error(explainProviderError(err, p, opts.model));
    }
  };
  return provider;
}

export type Check = { profile: string; provider: string; ok: boolean; line: string };

async function probe(url: string, headers: Record<string, string>, fetchImpl: typeof fetch, timeoutMs: number):
  Promise<{ status: number; body: unknown } | { error: unknown }> {
  try {
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    let body: unknown;
    try { body = await res.json(); } catch { body = undefined; }
    return { status: res.status, body };
  } catch (error) { return { error }; }
}

function listedModels(body: unknown): string[] {
  const b = body as { data?: { id?: unknown }[]; models?: { name?: unknown }[] } | undefined;
  const raw = b?.data?.map((m) => m.id) ?? b?.models?.map((m) => m.name) ?? [];
  return raw.filter((x): x is string => typeof x === "string");
}

/** Check one profile: configured (key present) and reachable (a free listing call). */
export async function checkProfile(p: ModelProfile, opts: { env?: Env; fetchImpl?: typeof fetch; timeoutMs?: number; model?: string } = {}): Promise<Check> {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const model = opts.model ?? p.model;
  const url = endpointFor(p, env).replace(/\/+$/, "");
  const keyEnv = keyEnvFor(p);
  const key = keyEnv ? env[keyEnv] : undefined;
  const done = (ok: boolean, line: string): Check => ({ profile: p.id, provider: p.provider, ok, line });

  if (p.provider === "anthropic" && !key) return done(false, `not configured: ANTHROPIC_API_KEY is not set. Fix: ${ANTHROPIC_KEY_FIX}.`);
  if (p.provider === "anthropic" && key && isOAuthToken(key)) return done(false, OAUTH_REFUSAL);
  if (p.provider !== "anthropic" && p.provider !== "ollama" && p.apiKeyEnv && !key) {
    return done(false, `not configured: ${p.apiKeyEnv} is not set. Fix: export ${p.apiKeyEnv}=<key for ${url}>.`);
  }

  const r = p.provider === "anthropic"
    ? await probe(`${url}/v1/models/${encodeURIComponent(model)}`, { "x-api-key": key!, "anthropic-version": "2023-06-01" }, fetchImpl, opts.timeoutMs ?? 5000)
    : p.provider === "ollama"
      ? await probe(`${url}/api/tags`, {}, fetchImpl, opts.timeoutMs ?? 5000)
      : await probe(`${url}/models`, key ? { authorization: `Bearer ${key}` } : {}, fetchImpl, opts.timeoutMs ?? 5000);

  if ("error" in r) return done(false, hint("unreachable", p, model, url));
  if (r.status === 401 || r.status === 403) return done(false, hint("auth", p, model, url));
  if (p.provider === "anthropic") {
    if (r.status === 404) return done(false, hint("no-model", p, model, url));
    return r.status === 200 ? done(true, `ready: ${model} at ${url}`) : done(false, `${url} answered HTTP ${r.status}.`);
  }
  if (r.status !== 200) {
    // Some OpenAI-compatible servers do not implement GET /models; reachable is all we can say.
    return p.provider === "ollama" ? done(false, `${url} answered HTTP ${r.status}; is it an ollama server?`)
      : done(true, `reachable: ${url} (could not list models, HTTP ${r.status}; ${model} unverified)`);
  }
  const models = listedModels(r.body);
  const has = models.includes(model) || (p.provider === "ollama" && models.includes(`${model}:latest`));
  return has ? done(true, `ready: ${model} at ${url}`) : done(false, hint("no-model", p, model, url, models));
}

/** `doctor` subcommand: one line per profile, plus how to start. ok = at least one profile is ready. */
export async function runDoctor(profiles: readonly ModelProfile[], defaultId: string, opts: Parameters<typeof checkProfile>[1] = {}): Promise<{ text: string; ok: boolean }> {
  const checks = await Promise.all(profiles.map((p) => checkProfile(p, opts)));
  const lines = ["raziel doctor: checking each profile with a free listing call (no tokens spent)"];
  for (const c of checks) lines.push(`  ${c.ok ? "ok  " : "FAIL"} ${c.profile.padEnd(12)} ${c.provider.padEnd(17)} ${c.line}`);
  const ready = checks.filter((c) => c.ok).map((c) => c.profile);
  if (ready.length === 0) lines.push("No profile is ready yet. Apply one fix above, then run `bun run src/cli.ts doctor` again.");
  else lines.push(ready.includes(defaultId) ? "Start with: bun run src/cli.ts" : `Start with: bun run src/cli.ts --profile ${ready[0]}`);
  return { text: sanitizeForTerminal(lines.join("\n")) + "\n", ok: ready.length > 0 };
}
