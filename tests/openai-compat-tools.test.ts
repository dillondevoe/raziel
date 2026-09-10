import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAICompatProvider } from "../src/providers/openai_compat";
import type { Provider, StreamChunk } from "../src/provider";
import { Engine } from "../src/engine";
import { SessionStore } from "../src/session";
import { Workspace } from "../src/tools/workspace";
import { builtinTools, sliceTools } from "../src/tools/registry";
import { getProfile, type ModelProfile } from "../src/profiles";
// A tool-bearing openai-compat profile exists ONLY as a test fixture: gpt-6-astra refuses
// function tools on Chat Completions (measured live 2026-09-10, see src/profiles.ts), so the
// registry must not advertise one. The channel itself is real for other compat endpoints.
const agentFixture: ModelProfile = { id: "compat-agent", provider: "openai-compat", model: "test-model",
  baseUrl: "http://127.0.0.1/v1", contextTokens: 32_768, maxToolSurface: 7, parser: "native",
  streamingTools: true, apiKeyEnv: "RAZIEL_COMPAT_KEY" };
import { ApprovalManager } from "../src/approvals";
import { Rules } from "../src/rules";

function chunk(delta: unknown, finish_reason: string | null = null): string {
  return `data: ${JSON.stringify({ id: "completion", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
}
function reply(body: string): Response {
  return new Response(body + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}
function call(index: number, args: string, name?: string) {
  return { index, ...(name ? { id: `call-${index}`, type: "function" } : {}), function: { ...(name ? { name } : {}), arguments: args } };
}
async function fixture(handler: (req: Request) => Promise<Response> | Response, run: (p: Provider) => Promise<void>) {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
  try { await run(new OpenAICompatProvider({ baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "test-key" })); }
  finally { server.stop(true); }
}
const readSpec = builtinTools().get("read_file")!.spec;

test("openai-compat advertises schemas and emits complete interleaved calls exactly once", async () => {
  let body: any;
  await fixture(async (req) => {
    body = await req.json();
    return reply(
      chunk({ content: "Inspecting", tool_calls: [call(0, '{"path":"a', "read_file"), call(1, '{"pattern":', "glob")] }) +
      chunk({ tool_calls: [call(1, '"*.ts"}'), call(0, '.txt"}')] }) + chunk({}, "tool_calls"),
    );
  }, async (p) => {
    const chunks: StreamChunk[] = [];
    for await (const c of p.stream({ model: "test", messages: [], tools: [readSpec] })) chunks.push(c);
    expect(chunks).toEqual([
      { type: "delta", text: "Inspecting" },
      { type: "tool_call", id: "call-0", name: "read_file", args: { path: "a.txt" } },
      { type: "tool_call", id: "call-1", name: "glob", args: { pattern: "*.ts" } },
      { type: "done", stopReason: "end" },
    ]);
  });
  expect(body.tools).toEqual([{ type: "function", function: expect.objectContaining({ name: readSpec.name, description: readSpec.description, parameters: readSpec.inputSchema }) }]);
  expect(body.temperature).toBeUndefined();
  expect(body.top_p).toBeUndefined();
  expect(body.max_completion_tokens ?? body.max_tokens).toBe(8192);
});

test("openai-compat treats empty arguments as a zero-arg call ({}), like the anthropic provider", async () => {
  await fixture(() => reply(chunk({ tool_calls: [call(0, "", "read_file")] }) + chunk({}, "tool_calls")), async (p) => {
    const calls: StreamChunk[] = [];
    for await (const c of p.stream({ model: "test", messages: [], tools: [readSpec] })) {
      if (c.type === "tool_call") calls.push(c);
    }
    expect(calls).toEqual([{ type: "tool_call", id: "call-0", name: "read_file", args: {} }]);
  });
});

test("openai-compat ignores stray tool events when the caller offered no tools, keeping the text", async () => {
  await fixture(() => reply(chunk({ content: "The answer is 42." }) + chunk({ tool_calls: [call(0, "", "list")] }) + chunk({}, "stop")), async (p) => {
    const seen: StreamChunk[] = [];
    for await (const c of p.stream({ model: "test", messages: [] })) seen.push(c);
    expect(seen.filter((c) => c.type === "tool_call")).toEqual([]);
    expect(seen.find((c) => c.type === "delta")).toEqual({ type: "delta", text: "The answer is 42." });
  });
});

for (const raw of ['{"path":"a.txt"', '{"path":}']) {
  test(`openai-compat refuses incomplete tool JSON ${JSON.stringify(raw)}`, async () => {
    await fixture(() => reply(chunk({ tool_calls: [call(0, raw, "read_file")] }) + chunk({}, "tool_calls")), async (p) => {
      const calls: StreamChunk[] = [];
      await expect(async () => {
        for await (const c of p.stream({ model: "test", messages: [], tools: [readSpec] })) {
          if (c.type === "tool_call") calls.push(c);
        }
      }).toThrow(/invalid tool JSON/);
      expect(calls).toEqual([]);
    });
  });
}

test("openai-compat keeps text-only requests tool-free and abort suppresses buffered calls", async () => {
  let body: any;
  await fixture(async (req) => {
    body = await req.json();
    return reply(chunk({ content: "first", tool_calls: [call(0, "{}", "glob")] }) + chunk({}, "tool_calls"));
  }, async (p) => {
    const ctl = new AbortController();
    const chunks: StreamChunk[] = [];
    for await (const c of p.stream({ model: "test", messages: [], signal: ctl.signal })) {
      chunks.push(c);
      ctl.abort();
    }
    expect(chunks).toEqual([{ type: "delta", text: "first" }]);
  });
  expect(body.tools).toBeUndefined();
});

for (const allow of [true, false]) {
  test(`compat-agent round trip persists ${allow ? "file evidence" : "denial"} and returns it to the provider`, async () => {
    const profile: ModelProfile | undefined = agentFixture;
    // astra-agent now EXISTS (a live arm earned it, PR #4) but it is an
    // openai-responses profile; this compat arm still runs on its own fixture.
    expect(getProfile("astra-agent")!.provider).toBe("openai-responses");
    expect(getProfile("astra")!.maxToolSurface).toBe(0);
    expect(profile!.sampling).toBeUndefined();
    const root = mkdtempSync(join(tmpdir(), "raziel-compat-tool-"));
    const prev = process.env.RAZIEL_HOME;
    process.env.RAZIEL_HOME = root;
    try {
      writeFileSync(join(root, "note.txt"), "audit evidence");
      const registry = sliceTools(builtinTools(), profile!.maxToolSurface);
      expect([...registry.keys()]).toContain("run_command");
      let rounds = 0;
      const requests: any[] = [];
      await fixture(async (req) => {
        requests.push(await req.json());
        return rounds++ === 0
          ? reply(chunk({ tool_calls: [call(0, '{"path":"note.txt"}', "read_file")] }) + chunk({}, "tool_calls"))
          : reply(chunk({ content: "collected" }) + chunk({}, "stop"));
      }, async (provider) => {
        const store = new SessionStore("audit-job");
        const rulesPath = join(root, "rules.json");
        const approvals = new ApprovalManager(Rules.load(rulesPath), { ask: async () => allow ? "allow" : "deny" }, rulesPath);
        const engine = new Engine({ provider, store, profile: profile!, tools: { registry, approvals, ws: new Workspace(root) } });
        for await (const _ of engine.send("read note.txt")) { /* drain */ }
        const result = store.replay().find((e) => e.type === "tool_result");
        expect(result).toMatchObject({ ok: allow, output: allow ? "audit evidence" : "denied by user", taint: "tool_output" });
        expect(store.replay().at(-1)).toMatchObject({ type: "turn_end", stop: "end" });
        // The round replays as a REAL tool exchange now, not a stringified user
      // message: the assistant turn claims the call and a role:"tool" message
      // answers it by id. Asserting the old user-message form here is what let
      // the starvation defect ship green.
      const replayed = requests[1].messages;
      expect(replayed.some((m: any) => typeof m.content === "string" && m.content.includes("[tool_result"))).toBe(false);
      const asst = replayed.find((m: any) => m.role === "assistant" && m.tool_calls?.length);
      expect(asst.tool_calls[0].function.name).toBe("read_file");
      const toolMsg = replayed.find((m: any) => m.role === "tool");
      expect(toolMsg.content).toContain(allow ? "audit evidence" : "denied by user");
      expect(toolMsg.tool_call_id).toBe(asst.tool_calls[0].id);
        expect(requests[0].tools.map((t: any) => t.function.name)).toEqual([...registry.keys()]);
      });
    } finally {
      if (prev === undefined) delete process.env.RAZIEL_HOME;
      else process.env.RAZIEL_HOME = prev;
      rmSync(root, { recursive: true, force: true });
    }
  });
}
