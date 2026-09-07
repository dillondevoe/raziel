import { describe, expect, test } from "bun:test";
import {
  AnthropicProvider,
  isOAuthToken,
  asProviderError,
  CLAUDE_CODE_IDENTITY,
  CLAUDE_CODE_UA_VERSION,
} from "../src/providers/anthropic";

// The acceptance signal geist set: not "the client was constructed with the
// right options" — a mock would have agreed with the BROKEN code on that — but
// the bytes that actually leave. Every arm below drives a real
// AnthropicProvider through a real @anthropic-ai/sdk and reads the Request the
// SDK hands to fetch. If the transport is wrong, these go red.
type Capture = { url: string; headers: Record<string, string>; body: any };

function intercept(): { fetchImpl: typeof fetch; seen: Capture[] } {
  const seen: Capture[] = [];
  const fetchImpl = (async (input: any, init?: any) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    const text = await req.text();
    seen.push({ url: req.url, headers, body: text ? JSON.parse(text) : undefined });
    // A minimal well-formed SSE message stream, so the provider's own parse
    // path runs rather than being short-circuited by an error.
    const sse =
      `event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"m","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}\n\n` +
      `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n` +
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n` +
      `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n` +
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n` +
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

async function drive(apiKey: string, system?: string): Promise<Capture> {
  const { fetchImpl, seen } = intercept();
  const p = new AnthropicProvider({ apiKey, fetchImpl });
  for await (const _ of p.stream({ model: "claude-x", system, messages: [{ role: "user", content: "hi" }] })) {
    // drain
  }
  expect(seen.length).toBe(1);
  return seen[0]!;
}

const OAUTH = "sk-ant-oat01-" + "z".repeat(90);
const APIKEY = "sk-ant-api03-" + "z".repeat(90);

describe("isOAuthToken", () => {
  test("discriminates the two credential kinds", () => {
    expect(isOAuthToken(OAUTH)).toBe(true);
    expect(isOAuthToken(APIKEY)).toBe(false);
    expect(isOAuthToken("")).toBe(false);
  });
});

describe("OAuth transport (intercepted request)", () => {
  test("an sk-ant-oat token goes out as Authorization: Bearer, never x-api-key", async () => {
    const c = await drive(OAUTH);
    expect(c.headers["authorization"]).toBe(`Bearer ${OAUTH}`);
    // This is the whole defect. Before the fix the token arrived here instead,
    // and the API answered "API key is invalid" for a perfectly good credential.
    expect(c.headers["x-api-key"]).toBeUndefined();
  });

  test("carries the Claude Code identity headers", async () => {
    const c = await drive(OAUTH);
    expect(c.headers["anthropic-beta"]).toContain("oauth-2025-04-20");
    expect(c.headers["anthropic-beta"]).toContain("claude-code-20250219");
    expect(c.headers["user-agent"]).toBe(`claude-cli/${CLAUDE_CODE_UA_VERSION}`);
    expect(c.headers["x-app"]).toBe("cli");
  });

  test("system is a block array led by the Claude Code identity", async () => {
    const c = await drive(OAUTH);
    expect(Array.isArray(c.body.system)).toBe(true);
    expect(c.body.system[0]).toEqual({ type: "text", text: CLAUDE_CODE_IDENTITY });
    expect(c.body.system.length).toBe(1);
  });

  test("a caller system prompt is APPENDED, not substituted for the identity", async () => {
    const c = await drive(OAUTH, "You are Astra.");
    expect(c.body.system.length).toBe(2);
    expect(c.body.system[0]!.text).toBe(CLAUDE_CODE_IDENTITY);
    expect(c.body.system[1]).toEqual({ type: "text", text: "You are Astra." });
  });
});

describe("API-key transport is UNCHANGED (control arm)", () => {
  // Dillon has live sk-ant-api03 keys on mini and DVo. Fixing OAuth by breaking
  // those would be a bad trade, so this arm exists to make that trade visible.
  test("an sk-ant-api03 key still goes out as x-api-key with no Bearer", async () => {
    const c = await drive(APIKEY);
    expect(c.headers["x-api-key"]).toBe(APIKEY);
    expect(c.headers["authorization"]).toBeUndefined();
  });

  test("no Claude Code identity headers leak onto the API-key path", async () => {
    const c = await drive(APIKEY);
    expect(c.headers["x-app"]).toBeUndefined();
    expect(c.headers["anthropic-beta"]).toBeUndefined();
    expect(c.headers["user-agent"] ?? "").not.toContain("claude-cli/");
  });

  test("system stays a bare string on the API-key path", async () => {
    const c = await drive(APIKEY, "You are Astra.");
    expect(c.body.system).toBe("You are Astra.");
  });

  test("and is absent when the caller sets none", async () => {
    const c = await drive(APIKEY);
    expect(c.body.system).toBeUndefined();
  });
});

describe("429 is a plan ceiling, not an auth failure", () => {
  test("a 429 is renamed and carries retry-after", () => {
    const err: any = new Error("rate_limit_error");
    err.status = 429;
    err.headers = { "retry-after": "60" };
    const out = asProviderError(err);
    expect(out.message).toContain("plan's usage ceiling");
    expect(out.message).toContain("not a bad credential");
    expect(out.message).toContain("60s");
    expect(out.message).toContain("rate_limit_error");
  });

  test("Headers instances are read too, not just plain objects", () => {
    const err: any = new Error("rate_limit_error");
    err.status = 429;
    err.headers = new Headers({ "retry-after": "30" });
    expect(asProviderError(err).message).toContain("30s");
  });

  test("a 429 with no retry-after still says to wait", () => {
    const err: any = new Error("rate_limit_error");
    err.status = 429;
    expect(asProviderError(err).message).toContain("Retry shortly");
  });

  // Control arm: the mapper must not swallow every error into a rate-limit
  // story. A genuine 401 has to keep saying 401, or the fix for a
  // misdiagnosed error becomes a new misdiagnosis.
  test("a 401 passes through untouched", () => {
    const err: any = new Error("authentication_error: invalid x-api-key");
    err.status = 401;
    const out = asProviderError(err);
    expect(out.message).toBe("authentication_error: invalid x-api-key");
    expect(out.message).not.toContain("plan's usage ceiling");
    expect(out).toBe(err);
  });

  test("a non-Error rejection is still an Error", () => {
    expect(asProviderError("boom")).toBeInstanceOf(Error);
    expect(asProviderError("boom").message).toBe("boom");
  });
});
