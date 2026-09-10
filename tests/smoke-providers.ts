// Explicit live probe, never included by `bun test`.
// Run: bun run tests/smoke-providers.ts [sonnet|astra|qwen]
// Credentials stay in the environment. No prompts, replies, or keys are saved.
import { providerFor } from "../src/commands";
import { getProfile } from "../src/profiles";

const ids = process.argv.slice(2);
if (ids.length === 0) ids.push("sonnet", "astra", "qwen");

for (const id of ids) {
  const profile = getProfile(id);
  if (!profile) throw new Error("unknown probe profile");
  const keyEnv = profile.provider === "anthropic" ? "ANTHROPIC_API_KEY" : profile.apiKeyEnv;
  if (keyEnv && !process.env[keyEnv]) {
    console.log(`${id}: BLOCKED (${keyEnv} unset)`);
    process.exitCode = 1;
    continue;
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20_000);
  try {
    const provider = providerFor(profile);
    let text = "";
    let done = false;
    for await (const chunk of provider.stream({
      model: profile.model,
      system: "Reply with exactly phase1-ok.",
      messages: [{ role: "user", content: "Reply with exactly phase1-ok." }],
      sampling: profile.sampling,
      contextTokens: profile.contextTokens,
      signal: ctl.signal,
    })) {
      if (chunk.type === "delta") text += chunk.text;
      if (chunk.type === "done") done = chunk.stopReason === "end";
    }
    const ok = done && text.trim() === "phase1-ok";
    console.log(`${id}: ${ok ? "WORKS" : "FAIL"} (done=${done}, replyMatches=${text.trim() === "phase1-ok"}, timeout=${ctl.signal.aborted})`);
    if (!ok) process.exitCode = 1;
  } catch (err) {
    // Classify without printing upstream bodies, which may echo credentials.
    const message = err instanceof Error ? err.message : "";
    const reason = ctl.signal.aborted ? "timeout"
      : /429|rate.limit/i.test(message) ? "rate limited"
      : /401|authenticat|invalid.*key/i.test(message) ? "authentication"
      : /connect|fetch|network|ECONN/i.test(message) ? "connection"
      : "provider error";
    console.log(`${id}: BLOCKED (${reason})`);
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
  }
}
