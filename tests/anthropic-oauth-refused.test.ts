import { describe, expect, test } from "bun:test";
import { AnthropicProvider, isOAuthToken, OAUTH_REFUSAL } from "../src/providers/anthropic";
import { readFileSync } from "node:fs";

// 2026-09-20: raziel used to make a Claude SUBSCRIPTION token work by presenting itself to
// Anthropic as Claude Code (user-agent, identity block, tool names). That path is removed.
// These arms keep it removed: the token is refused, and the impersonation strings cannot return.
const OAUTH = "sk-ant-oat01-" + "z".repeat(90);
const APIKEY = "sk-ant-api03-" + "z".repeat(90);

describe("subscription tokens are refused, not disguised", () => {
  test("detector tells the two credential kinds apart", () => {
    expect(isOAuthToken(OAUTH)).toBe(true);
    expect(isOAuthToken(APIKEY)).toBe(false);
  });
  test("constructing the provider with a subscription token throws the refusal", () => {
    expect(() => new AnthropicProvider({ apiKey: OAUTH })).toThrow(OAUTH_REFUSAL);
  });
  test("CONTROL: a console API key still constructs", () => {
    expect(() => new AnthropicProvider({ apiKey: APIKEY })).not.toThrow();
  });
  test("the refusal also covers the environment variable door", () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = OAUTH;
    try { expect(() => new AnthropicProvider()).toThrow(OAUTH_REFUSAL); }
    finally { if (prev === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prev; }
  });
  test("no impersonation material is left in the provider source", () => {
    const src = readFileSync(new URL("../src/providers/anthropic.ts", import.meta.url), "utf8");
    for (const banned of ["claude-cli/", "claude-code-20250219", "oauth-2025-04-20", "authToken", "x-app"]) {
      expect(src.includes(banned)).toBe(false);
    }
    expect(/You are Claude Code, Anthropic/.test(src)).toBe(false);
  });
});
