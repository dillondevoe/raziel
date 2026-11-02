import { test, expect, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkProfile, explainProviderError, runDoctor, withPlainErrors } from "../src/doctor";
import { providerFor } from "../src/commands";
import { crashLine } from "../src/cli";
import { AnthropicProvider } from "../src/providers/anthropic";
import { getProfile, type ModelProfile } from "../src/profiles";
import type { Provider, StreamChunk } from "../src/provider";

const sonnet = getProfile("sonnet")!;
const qwen = getProfile("qwen")!;
const astra = getProfile("astra")!;
const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; });

const refused = () => Object.assign(new TypeError("ECONNREFUSED: Unable to connect. Is the computer able to access the url?"), { code: "ECONNREFUSED" });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fetchOf = (f: (url: string) => Response | Promise<Response>) => (async (u: string | URL | Request) => f(String(u))) as unknown as typeof fetch;
async function drain(p: Provider, model: string): Promise<string> {
  try { for await (const _ of p.stream({ model, messages: [{ role: "user", content: "hi" }] })) { /* */ } return "no error"; }
  catch (e) { return (e as Error).message; }
}

// --- turn-time messages (error text shapes captured from the real SDKs) ---

test("wrong Anthropic key: names ANTHROPIC_API_KEY and how to fix it, through the real SDK", async () => {
  const p = withPlainErrors(new AnthropicProvider({ apiKey: "sk-ant-api-bogus",
    fetchImpl: fetchOf(() => json(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } })) }), sonnet);
  expect(p).toBeInstanceOf(AnthropicProvider);
  const msg = await drain(p, "claude-sonnet-5");
  expect(msg).toBe("Anthropic rejected the key in ANTHROPIC_API_KEY. Fix: export ANTHROPIC_API_KEY=sk-ant-api... (create a key at console.anthropic.com).");
});

test("wrong Anthropic model name: says which model and to pass --model", async () => {
  const p = withPlainErrors(new AnthropicProvider({ apiKey: "sk-ant-api-x",
    fetchImpl: fetchOf(() => json(404, { type: "error", error: { type: "not_found_error", message: "model: claude-nope" } })) }), sonnet);
  expect(await drain(p, "claude-nope")).toBe('Anthropic has no model "claude-nope". Fix: pass --model <model id>.');
});

test("Anthropic unreachable: a network message, not a stack", () => {
  const err = Object.assign(new Error("Connection error."), { cause: { code: "ECONNREFUSED" } });
  expect(explainProviderError(err, sonnet, "m", {})).toMatch(/^cannot reach Anthropic at https:\/\/api\.anthropic\.com\. Fix: check your network/);
});

test("ollama not running: names `ollama serve` and RAZIEL_OLLAMA_URL, through providerFor", async () => {
  process.env.RAZIEL_OLLAMA_URL = "http://127.0.0.1:9";
  const p = providerFor(qwen, fetchOf(() => { throw refused(); }));
  expect(await drain(p, qwen.model)).toBe("ollama is not running at http://127.0.0.1:9. Fix: start it with `ollama serve` (install from ollama.com), or set RAZIEL_OLLAMA_URL=http://<host>:11434 if it runs elsewhere.");
});

test("ollama model not pulled: gives the exact `ollama pull`", async () => {
  const p = providerFor(qwen, fetchOf(() => new Response('{"error":"model \\"qwen2.5:7b\\" not found, try pulling it first"}', { status: 404 })));
  expect(await drain(p, "qwen2.5:7b")).toBe('ollama has no model "qwen2.5:7b". Fix: `ollama pull qwen2.5:7b`.');
});

test("OpenAI-compatible endpoint: unreachable, bad key, unknown model (pi-ai message shapes)", () => {
  const env = { RAZIEL_COMPAT_URL: "http://localhost:8000/v1" };
  expect(explainProviderError(new Error("Connection error."), astra, "m", env))
    .toBe("nothing answered at http://localhost:8000/v1. Fix: start the server, or set RAZIEL_COMPAT_URL=<base url ending in /v1>.");
  expect(explainProviderError(new Error('401: {"message":"bad key"}'), astra, "m", env))
    .toBe("http://localhost:8000/v1 rejected the key in RAZIEL_COMPAT_KEY. Fix: export RAZIEL_COMPAT_KEY=<a key for that endpoint>.");
  expect(explainProviderError(new Error('404: {"message":"model: llama"}'), astra, "llama", env))
    .toMatch(/^http:\/\/localhost:8000\/v1 has no model "llama"\. Fix: pass --model <name>/);
  expect(explainProviderError(new Error("OpenAI API error (401): nope"), getProfile("astra-agent")!, "m", {}))
    .toMatch(/rejected the key in RAZIEL_COMPAT_KEY/);
});

test("an error outside the known cases passes through unchanged; an abort is not rewritten", async () => {
  expect(explainProviderError(new Error("anthropic: rate limited (429) — x"), sonnet, "m", {})).toBe("anthropic: rate limited (429) — x");
  const ctl = new AbortController();
  const inner: Provider = { name: "x", async *stream(): AsyncIterable<StreamChunk> { ctl.abort(); throw Object.assign(new Error("401 aborted"), { status: 401 }); } };
  const p = withPlainErrors(inner, sonnet);
  await expect((async () => { for await (const _ of p.stream({ model: "m", messages: [], signal: ctl.signal })) { /* */ } })()).rejects.toThrow("401 aborted");
});

// --- startup messages ---

test("no key at all: the startup message names the env var, the local door, and doctor", () => {
  delete process.env.ANTHROPIC_API_KEY;
  expect(() => providerFor(sonnet)).toThrow(/ANTHROPIC_API_KEY is not set\. Fix: export ANTHROPIC_API_KEY=sk-ant-api.*--profile qwen.*doctor/);
});

test("RAZIEL_COMPAT_URL points the openai-compat door at your own endpoint; missing key names the var", () => {
  process.env.RAZIEL_COMPAT_URL = "http://localhost:1234/v1";
  delete process.env.RAZIEL_COMPAT_KEY;
  expect(() => providerFor(astra)).toThrow("profile astra requires RAZIEL_COMPAT_KEY to be set. Fix: export RAZIEL_COMPAT_KEY=<key for http://localhost:1234/v1>");
  process.env.RAZIEL_COMPAT_KEY = "none";
  expect(providerFor(astra).name).toBe("openai-compat");
});

test("crashLine: one line by default, a stack only with RAZIEL_DEBUG", () => {
  const e = new Error("disk full");
  expect(crashLine(e, false)).toBe("raziel: disk full (set RAZIEL_DEBUG=1 for a stack trace)\n");
  expect(crashLine(e, true)).toContain("at ");
});

// --- doctor ---

test("doctor/anthropic: not configured, subscription token refused, ready, bad key, bad model", async () => {
  expect((await checkProfile(sonnet, { env: {} })).line).toMatch(/^not configured: ANTHROPIC_API_KEY is not set\. Fix: export/);
  expect((await checkProfile(sonnet, { env: { ANTHROPIC_API_KEY: "sk-ant-oat01-x" } })).line).toMatch(/subscription token.*Raziel does not accept it/);
  const seen: string[] = [];
  const ok = await checkProfile(sonnet, { env: { ANTHROPIC_API_KEY: "sk-ant-api-x" }, fetchImpl: fetchOf((u) => { seen.push(u); return json(200, { id: "claude-sonnet-5" }); }) });
  expect(ok).toMatchObject({ ok: true, line: "ready: claude-sonnet-5 at https://api.anthropic.com" });
  expect(seen).toEqual(["https://api.anthropic.com/v1/models/claude-sonnet-5"]); // a free GET, never /v1/messages
  expect((await checkProfile(sonnet, { env: { ANTHROPIC_API_KEY: "k" }, fetchImpl: fetchOf(() => json(401, {})) })).line).toMatch(/rejected the key in ANTHROPIC_API_KEY/);
  expect((await checkProfile(sonnet, { env: { ANTHROPIC_API_KEY: "k" }, model: "claude-x", fetchImpl: fetchOf(() => json(404, {})) })).line).toMatch(/no model "claude-x"/);
});

test("doctor/ollama: not running, model missing (lists what it has), ready incl. :latest", async () => {
  const dead = await checkProfile(qwen, { env: {}, fetchImpl: fetchOf(() => { throw refused(); }) });
  expect(dead).toMatchObject({ ok: false });
  expect(dead.line).toContain("`ollama serve`");
  const tags = (names: string[]) => fetchOf(() => json(200, { models: names.map((name) => ({ name })) }));
  expect((await checkProfile(qwen, { env: {}, fetchImpl: tags(["llama3:latest"]) })).line).toBe('ollama has no model "qwen2.5:7b". Fix: `ollama pull qwen2.5:7b`.');
  expect((await checkProfile(qwen, { env: {}, fetchImpl: tags(["qwen2.5:7b"]) })).ok).toBe(true);
  expect((await checkProfile(qwen, { env: {}, model: "llama3", fetchImpl: tags(["llama3:latest"]) })).ok).toBe(true);
});

test("doctor/openai-compat: missing key, model listed, model not listed, no /models route", async () => {
  expect((await checkProfile(astra, { env: {} })).line).toMatch(/^not configured: RAZIEL_COMPAT_KEY is not set/);
  const env = { RAZIEL_COMPAT_KEY: "k", RAZIEL_COMPAT_URL: "http://localhost:8000/v1/" };
  const list = fetchOf((u) => { expect(u).toBe("http://localhost:8000/v1/models"); return json(200, { data: [{ id: "llama-3" }, { id: "qwen" }] }); });
  expect((await checkProfile(astra, { env, model: "qwen", fetchImpl: list })).ok).toBe(true);
  const miss = await checkProfile(astra, { env, fetchImpl: list });
  expect(miss.line).toContain('no model "gpt-6-astra". Fix: pass --model <name> (it serves: llama-3, qwen)');
  expect((await checkProfile(astra, { env, fetchImpl: fetchOf(() => json(404, {})) })).line).toMatch(/^reachable: .*unverified/);
});

test("runDoctor: ok when any profile is ready, and says how to start", async () => {
  const env = { ANTHROPIC_API_KEY: "sk-ant-api-x" };
  const fetchImpl = fetchOf((u) => u.includes("anthropic") ? json(200, {}) : (() => { throw refused(); })());
  const r = await runDoctor([sonnet, qwen] as ModelProfile[], "sonnet", { env, fetchImpl });
  expect(r.ok).toBe(true);
  expect(r.text).toContain("ok   sonnet");
  expect(r.text).toContain("FAIL qwen");
  expect(r.text).toContain("Start with: bun run src/cli.ts\n");
  const none = await runDoctor([qwen], "sonnet", { env: {}, fetchImpl });
  expect(none.ok).toBe(false);
  // A model override that made the check pass is carried into the start command.
  const compat = fetchOf(() => json(200, { data: [{ id: "local-llm" }] }));
  const custom = await runDoctor([{ ...astra, model: "local-llm" }], "sonnet", { env: { RAZIEL_COMPAT_KEY: "k" }, fetchImpl: compat });
  expect(custom.text).toContain("Start with: bun run src/cli.ts --profile astra --model local-llm\n");
});

// --- the real first run, as a subprocess: no key, no ollama, no config ---

test("clean first run: no key -> one line, exit 1, no stack trace; doctor exits 1 with fixes", () => {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: mkdtempSync(join(tmpdir(), "raziel-home-")),
    RAZIEL_HOME: mkdtempSync(join(tmpdir(), "raziel-test-")), RAZIEL_OLLAMA_URL: "http://127.0.0.1:9" };
  const cli = join(import.meta.dir, "..", "src", "cli.ts");
  const run = Bun.spawnSync(["bun", "run", cli], { env, stdin: "ignore" });
  expect(run.exitCode).toBe(1);
  const err = run.stderr.toString();
  expect(err.trim().split("\n")).toHaveLength(1);
  expect(err).toMatch(/^raziel: no Anthropic API key/);
  const doc = Bun.spawnSync(["bun", "run", cli, "doctor", "--profile", "qwen"], { env, stdin: "ignore" });
  expect(doc.exitCode).toBe(1);
  expect(doc.stdout.toString()).toContain("ollama is not running at http://127.0.0.1:9");
  const bad = Bun.spawnSync(["bun", "run", cli, "--profile", "nope"], { env, stdin: "ignore" });
  expect(bad.stderr.toString()).toBe('raziel: unknown profile "nope". Fix: --profile <one of: sonnet, qwen, astra, astra-agent>\n');
});
