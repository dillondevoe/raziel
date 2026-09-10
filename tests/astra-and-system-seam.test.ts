import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProfile } from "../src/profiles";
import { expandHome, loadSystemPrompt } from "../src/system_prompt";
import { providerFor, createModelCommand } from "../src/commands";
import { Engine } from "../src/engine";
import { SessionStore } from "../src/session";
import { FakeProvider } from "../src/providers/fake";
import type { ModelProfile } from "../src/profiles";

beforeEach(() => { process.env.RAZIEL_HOME = mkdtempSync(join(tmpdir(), "raziel-test-")); });

async function drain(it: AsyncIterable<{ type: string }>) {
  const out: any[] = []; for await (const e of it) out.push(e); return out;
}

// ---------------------------------------------------------------------------
// The astra registry entry
// ---------------------------------------------------------------------------

test("astra profile carries the verified openai-compat shape", () => {
  const a = getProfile("astra")!;
  expect(a).toBeDefined();
  expect(a.provider).toBe("openai-compat");
  expect(a.model).toBe("gpt-6-astra");
  expect(a.baseUrl).toBe("https://api.openai.com/v1");
  expect(a.maxToolSurface).toBe(0);
  expect(a.apiKeyEnv).toBe("RAZIEL_COMPAT_KEY");
  expect(a.systemFile).toBe("profiles/astra.md");
});

// Astra rejects temperature AND top_p. Both stay off the wire only because
// `sampling` is absent — so assert the ABSENCE, and control-arm it against
// qwen, which does carry one. Without the qwen arm this test would pass just
// as happily against a registry where no profile can express sampling at all.
test("astra declares no sampling block (and the arm can see one when present)", () => {
  expect(getProfile("astra")!.sampling).toBeUndefined();
  expect(getProfile("qwen")!.sampling).toEqual({ temperature: 0.7, topP: 0.8 });
});

// ---------------------------------------------------------------------------
// The credential failure shape
// ---------------------------------------------------------------------------

let savedKey: string | undefined;
beforeEach(() => { savedKey = process.env.RAZIEL_COMPAT_KEY; });
afterEach(() => {
  if (savedKey === undefined) delete process.env.RAZIEL_COMPAT_KEY;
  else process.env.RAZIEL_COMPAT_KEY = savedKey;
});

// The defect this replaces: an unset key fell through to the provider's
// "not-needed" placeholder and came back as OpenAI's 401. Assert the
// rejection NAMES the variable — "it throws" would also pass if some
// earlier guard (missing baseUrl, unknown provider) shadowed this branch.
test("a keyed profile with its env var unset is refused BY NAME, not sent upstream", () => {
  delete process.env.RAZIEL_COMPAT_KEY;
  let msg = "";
  try { providerFor(getProfile("astra")!); } catch (e) { msg = (e as Error).message; }
  expect(msg).toContain("RAZIEL_COMPAT_KEY");
  expect(msg).toContain("astra");
  expect(msg).not.toContain("not-needed");
});

test("a keyed profile with its env var set constructs the provider", () => {
  process.env.RAZIEL_COMPAT_KEY = "sk-test-value";
  const p = providerFor(getProfile("astra")!);
  expect(p.name).toBe("openai-compat");
});

// The control arm for the guard above: a KEYLESS openai-compat profile (no
// apiKeyEnv) must still construct with no env var at all. Otherwise the fix
// would have quietly broken every local vLLM/LM Studio endpoint.
test("a keyless openai-compat profile still constructs with no env var set", () => {
  delete process.env.RAZIEL_COMPAT_KEY;
  const keyless: ModelProfile = {
    id: "local-x", provider: "openai-compat", model: "m",
    baseUrl: "http://127.0.0.1:8000/v1", contextTokens: 8192,
    maxToolSurface: 0, parser: "native", streamingTools: false,
  };
  expect(providerFor(keyless).name).toBe("openai-compat");
});

// ---------------------------------------------------------------------------
// loadSystemPrompt
// ---------------------------------------------------------------------------

test("expandHome expands a leading ~ and leaves everything else alone", () => {
  expect(expandHome("~/a/b", "/home/x")).toBe("/home/x/a/b");
  expect(expandHome("~", "/home/x")).toBe("/home/x");
  expect(expandHome("/abs/path", "/home/x")).toBe("/abs/path");
  expect(expandHome("rel/~/path", "/home/x")).toBe("rel/~/path");
});

test("a profile with no systemFile yields undefined and warns nothing", () => {
  const warnings: string[] = [];
  const out = loadSystemPrompt(getProfile("sonnet")!, { warn: (m) => warnings.push(m) });
  expect(out).toBeUndefined();
  expect(warnings).toEqual([]);
});

test("a readable systemFile is loaded, ~-expanded against the given home", () => {
  const home = mkdtempSync(join(tmpdir(), "raziel-home-"));
  mkdirSync(join(home, ".raziel", "profiles"), { recursive: true });
  writeFileSync(join(home, ".raziel", "profiles", "astra.md"), "You are Astra.\n");
  const warnings: string[] = [];
  const out = loadSystemPrompt(getProfile("astra")!, { home, warn: (m) => warnings.push(m) });
  expect(out).toBe("You are Astra.\n");
  expect(warnings).toEqual([]);
});

// A declared-but-missing persona must not be silent — silence is how the
// seam sat dead. It also must not throw: a broken file cannot be allowed to
// take down a /model swap or a session resume.
test("a declared-but-missing systemFile warns by path and degrades, never throws", () => {
  const home = mkdtempSync(join(tmpdir(), "raziel-home-"));
  const warnings: string[] = [];
  const out = loadSystemPrompt(getProfile("astra")!, { home, warn: (m) => warnings.push(m) });
  expect(out).toBeUndefined();
  expect(warnings.length).toBe(1);
  expect(warnings[0]).toContain("astra");
  expect(warnings[0]).toContain(join(home, ".raziel", "profiles", "astra.md"));
});

test("an empty systemFile is treated as missing, and says so", () => {
  const home = mkdtempSync(join(tmpdir(), "raziel-home-"));
  mkdirSync(join(home, ".raziel", "profiles"), { recursive: true });
  writeFileSync(join(home, ".raziel", "profiles", "astra.md"), "   \n");
  const warnings: string[] = [];
  const out = loadSystemPrompt(getProfile("astra")!, { home, warn: (m) => warnings.push(m) });
  expect(out).toBeUndefined();
  expect(warnings[0]).toContain("empty");
});

// ---------------------------------------------------------------------------
// The seam itself: a byte has to reach the provider
// ---------------------------------------------------------------------------

// This is the arm that could not have existed before: FakeProvider did not
// record `system` at all, so no test could have distinguished a wired seam
// from the dead one that shipped.
test("Engine passes system through to provider.stream (and omits it when unset)", async () => {
  const p = new FakeProvider([["ok"], ["ok"]]);
  await drain(new Engine({ provider: p, store: new SessionStore("s1"), model: "m", system: "PERSONA" }).send("hi"));
  await drain(new Engine({ provider: p, store: new SessionStore("s2"), model: "m" }).send("hi"));
  expect(p.optsLog[0]!.system).toBe("PERSONA");
  expect(p.optsLog[1]!.system).toBeUndefined();
});

// End to end through the real swap path: /model astra must build an Engine
// that carries astra's persona. The registry's own path is used, with HOME
// pointed at a fixture — no mock of loadSystemPrompt, so a call site that
// forgets to pass `system` fails here.
test("/model astra builds an engine whose provider receives astra's persona", async () => {
  const home = mkdtempSync(join(tmpdir(), "raziel-home-"));
  mkdirSync(join(home, ".raziel", "profiles"), { recursive: true });
  writeFileSync(join(home, ".raziel", "profiles", "astra.md"), "ASTRA-PERSONA\n");
  const savedHome = process.env.HOME;
  const savedRazielHome = process.env.RAZIEL_HOME;
  process.env.HOME = home;
  process.env.RAZIEL_HOME = join(home, ".raziel");   // a relative systemFile resolves against the STATE dir
  try {
    const fake = new FakeProvider([["ok"]]);
    const store = new SessionStore("s3");
    const engineBox = { current: new Engine({ provider: new FakeProvider([[]]), store, model: "m" }) };
    const cmd = createModelCommand({
      engineBox, store, initialProfile: getProfile("sonnet")!,
      write: () => {}, providerForFn: () => fake,
    });
    expect(cmd("/model astra")).toBe("handled");
    await drain(engineBox.current.send("hi"));
    expect(fake.optsLog[0]!.system).toBe("ASTRA-PERSONA\n");
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedRazielHome === undefined) delete process.env.RAZIEL_HOME; else process.env.RAZIEL_HOME = savedRazielHome;
  }
});
