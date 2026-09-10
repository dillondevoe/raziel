import { describe, expect, test } from "bun:test";
import { AnthropicProvider, toClaudeCodeName, fromClaudeCodeName, CLAUDE_CODE_TOOLS } from "../src/providers/anthropic";
import type { StreamChunk, ToolSpec } from "../src/provider";
import { builtinTools, toolSpecs } from "../src/tools/registry";

// Lane (a) of the raziel-sick-and-functional sprint: tool-name normalization on
// the OAuth path. The OAuth endpoint is the Claude Code door, and it is told it
// is talking to Claude Code (see CLAUDE_CODE_IDENTITY) — so the tool names it
// sees must be Claude Code's canonical ones where they correspond.
//
// The load-bearing property is that this is a ROUND TRIP. Normalizing only
// outbound converts a working path into a broken one: the model answers with
// `Grep`, the engine looks `Grep` up in a registry keyed `grep`
// (engine_tool_call.ts — `tools.registry.get(call.name)`), finds nothing, and
// returns "unknown tool". So every outbound arm below has an inbound twin, and
// the two are asserted against the REGISTRY KEY rather than against each other.

type Capture = { headers: Record<string, string>; body: any };

function sse(parts: string[]): string {
  return parts.map((p) => `event: ${JSON.parse(p).type}\ndata: ${p}\n\n`).join("");
}

const MSG_START = `{"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"m","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}`;
const MSG_END = `{"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":1}}`;
const MSG_STOP = `{"type":"message_stop"}`;

/** A well-formed SSE stream carrying exactly one tool_use block under `name`,
 * so the provider's real accumulate-and-strict-parse path runs. */
function toolUseStream(name: string, args: object = { pattern: "x" }): string {
  const json = JSON.stringify(JSON.stringify(args));
  return sse([
    MSG_START,
    `{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_1","name":${JSON.stringify(name)},"input":{}}}`,
    `{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":${json}}}`,
    `{"type":"content_block_stop","index":0}`,
    MSG_END,
    MSG_STOP,
  ]);
}

function intercept(body: string): { fetchImpl: typeof fetch; seen: Capture[] } {
  const seen: Capture[] = [];
  const fetchImpl = (async (input: any, init?: any) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    const text = await req.text();
    seen.push({ headers, body: text ? JSON.parse(text) : undefined });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

/** Drives a real AnthropicProvider through a real SDK, returning both halves of
 * the seam: the tool names that LEFT (off the intercepted request) and the
 * tool_call chunks that came BACK. */
async function roundTrip(
  apiKey: string,
  tools: ToolSpec[],
  serverToolName: string,
): Promise<{ sent: string[]; calls: Extract<StreamChunk, { type: "tool_call" }>[] }> {
  const { fetchImpl, seen } = intercept(toolUseStream(serverToolName));
  const p = new AnthropicProvider({ apiKey, fetchImpl });
  const calls: Extract<StreamChunk, { type: "tool_call" }>[] = [];
  for await (const c of p.stream({ model: "claude-x", messages: [{ role: "user", content: "hi" }], tools })) {
    if (c.type === "tool_call") calls.push(c);
  }
  expect(seen.length).toBe(1);
  return { sent: (seen[0]!.body.tools ?? []).map((t: any) => t.name), calls };
}

const OAUTH = "sk-ant-oat01-" + "z".repeat(90);
const APIKEY = "sk-ant-api03-" + "z".repeat(90);

const ALL = toolSpecs(builtinTools());
const spec = (name: string): ToolSpec => ({ name, description: "d", inputSchema: { type: "object", properties: {} } });

// ---------------------------------------------------------------------------
// ARMING ARM. Every arm below is only worth something because raziel's builtin
// names and Claude Code's canonical names genuinely intersect. If that
// intersection were empty, normalization would be a no-op and all of these
// would pass against code that does nothing at all. So assert the intersection
// and its SIZE here, and name the members — a zero is only informative if you
// first made it capable of being non-zero.
// ---------------------------------------------------------------------------
describe("the normalization is not vacuous (arming arm)", () => {
  test("exactly 2 of raziel's 7 builtins are renamed by CC canonicalization", () => {
    const renamed = ALL.map((t) => t.name).filter((n) => toClaudeCodeName(n) !== n);
    expect(renamed).toEqual(["grep", "glob"]);
    expect(toClaudeCodeName("grep")).toBe("Grep");
    expect(toClaudeCodeName("glob")).toBe("Glob");
  });

  test("and the other 5 are genuinely NOT Claude Code names (so pass-through is real, not untested)", () => {
    for (const n of ["read_file", "write_file", "edit_file", "run_command", "fetch"]) {
      expect(toClaudeCodeName(n)).toBe(n);
    }
    // The near-misses that make this worth asserting: these LOOK like they
    // should map and do not.
    expect(CLAUDE_CODE_TOOLS).toContain("Read");
    expect(CLAUDE_CODE_TOOLS).toContain("WebFetch");
    expect(CLAUDE_CODE_TOOLS).toContain("Bash");
  });
});

// ---------------------------------------------------------------------------
// OUTBOUND
// ---------------------------------------------------------------------------
describe("OAuth outbound: advertised tool names are CC-canonical on the wire", () => {
  test("grep and glob leave as Grep and Glob", async () => {
    const { sent } = await roundTrip(OAUTH, ALL, "Grep");
    expect(sent).toContain("Grep");
    expect(sent).toContain("Glob");
    expect(sent).not.toContain("grep");
    expect(sent).not.toContain("glob");
  });

  test("the five non-corresponding names are untouched", async () => {
    const { sent } = await roundTrip(OAUTH, ALL, "Grep");
    expect(sent).toEqual(["read_file", "write_file", "edit_file", "Grep", "Glob", "run_command", "fetch"]);
  });
});

describe("API-key outbound is UNCHANGED (control arm)", () => {
  // Without this arm a mapper that normalized unconditionally would pass every
  // OAuth arm above while silently changing the tool surface of every
  // console-API-key caller — Dillon has live sk-ant-api03 keys on mini and DVo.
  test("grep stays grep when the credential is a console API key", async () => {
    const { sent } = await roundTrip(APIKEY, ALL, "grep");
    expect(sent).toEqual(["read_file", "write_file", "edit_file", "grep", "glob", "run_command", "fetch"]);
  });
});

// ---------------------------------------------------------------------------
// INBOUND — the half that makes it a round trip rather than a break
// ---------------------------------------------------------------------------
describe("OAuth inbound: a CC-canonical tool_use name is inverted to the registry key", () => {
  test("Grep off the wire arrives as grep, which is what the registry is keyed on", async () => {
    const { calls } = await roundTrip(OAUTH, ALL, "Grep");
    expect(calls.length).toBe(1);
    expect(calls[0]!.name).toBe("grep");
    // The property that actually matters, asserted against the dispatcher's own
    // lookup table rather than against a literal.
    expect(builtinTools().has(calls[0]!.name)).toBe(true);
  });

  test("Glob too, and the args survive the strict parse alongside the rename", async () => {
    const { fetchImpl } = intercept(toolUseStream("Glob", { pattern: "**/*.ts" }));
    const p = new AnthropicProvider({ apiKey: OAUTH, fetchImpl });
    const calls: any[] = [];
    for await (const c of p.stream({ model: "m", messages: [{ role: "user", content: "hi" }], tools: ALL })) {
      if (c.type === "tool_call") calls.push(c);
    }
    expect(calls[0]!.name).toBe("glob");
    expect(calls[0]!.args).toEqual({ pattern: "**/*.ts" });
    expect(calls[0]!.id).toBe("tu_1");
  });

  test("inversion is built from the ADVERTISED set, not a static CC table", async () => {
    // `read_file` is not a Claude Code name, so a static table cannot invert
    // `Read_File` — it would hand the engine a name no registry holds. The
    // advertised set can, because canonicalization is lossy in principle and the
    // only authority on what was advertised is what was advertised.
    const { calls } = await roundTrip(OAUTH, ALL, "Read_File");
    expect(calls[0]!.name).toBe("read_file");
    expect(builtinTools().has(calls[0]!.name)).toBe(true);
  });

  test("a name matching NOTHING advertised passes through unchanged, not remapped", async () => {
    // Inversion must not invent a dispatchable name. A model that hallucinates
    // `Bash` while only grep/glob are advertised has to surface as the unknown
    // tool it is — engine_tool_call answers "unknown tool" — rather than being
    // quietly bent onto some other tool.
    const { calls } = await roundTrip(OAUTH, [spec("grep"), spec("glob")], "Bash");
    expect(calls[0]!.name).toBe("Bash");
    expect(builtinTools().has(calls[0]!.name)).toBe(false);
  });
});

describe("API-key inbound is UNCHANGED (control arm)", () => {
  test("no inversion runs on the console-API-key path", async () => {
    const { calls } = await roundTrip(APIKEY, ALL, "Grep");
    expect(calls[0]!.name).toBe("Grep");
  });
});

// ---------------------------------------------------------------------------
// The two halves meet. R13/R14 of the debounce battery, ported: an outbound arm
// and an inbound arm can both pass while the seam they share is never crossed.
// ---------------------------------------------------------------------------
describe("end-to-end: every renamed builtin survives a full round trip", () => {
  test("each of grep/glob goes out canonical and comes back dispatchable", async () => {
    for (const key of ["grep", "glob"]) {
      const canonical = toClaudeCodeName(key);
      expect(canonical).not.toBe(key); // the rename is real for this key
      const { sent, calls } = await roundTrip(OAUTH, ALL, canonical);
      expect(sent).toContain(canonical);
      expect(calls[0]!.name).toBe(key);
      expect(builtinTools().has(calls[0]!.name)).toBe(true);
    }
  });
});

describe("fromClaudeCodeName in isolation", () => {
  test("prefers an advertised tool over the raw name, case-insensitively", () => {
    expect(fromClaudeCodeName("GREP", [spec("grep")])).toBe("grep");
  });

  test("returns the name untouched with no tools advertised", () => {
    expect(fromClaudeCodeName("Grep", [])).toBe("Grep");
    expect(fromClaudeCodeName("Grep", undefined)).toBe("Grep");
  });
});
