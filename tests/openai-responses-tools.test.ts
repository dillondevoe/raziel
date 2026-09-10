import { test, expect } from "bun:test";
import { OpenAIResponsesProvider } from "../src/providers/openai_responses";
import type { Provider, StreamChunk } from "../src/provider";
import { builtinTools } from "../src/tools/registry";
import { providerFor } from "../src/commands";
import { listProfiles, type ModelProfile } from "../src/profiles";

// --- SSE framing -----------------------------------------------------------
// The Responses adapter drives the official OpenAI SDK, which parses `event:` +
// `data:` pairs, so the fixture emits both rather than data-only frames.
function ev(type: string, body: Record<string, unknown> = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`;
}
function fnItem(id: string, name: string, args = ""): Record<string, unknown> {
  return { type: "function_call", id: `item-${id}`, call_id: id, name, arguments: args, status: "in_progress" };
}
function completed(): string {
  return ev("response.completed", {
    response: {
      id: "resp-1", object: "response", model: "test", status: "completed",
      output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    },
  });
}
function reply(body: string): Response {
  return new Response(ev("response.created", { response: { id: "resp-1", object: "response", model: "test", status: "in_progress", output: [] } }) + body + completed(),
    { headers: { "content-type": "text/event-stream" } });
}
async function fixture(handler: (req: Request) => Promise<Response> | Response, run: (p: Provider) => Promise<void>) {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
  try { await run(new OpenAIResponsesProvider({ baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "test-key" })); }
  finally { server.stop(true); }
}
const readSpec = builtinTools().get("read_file")!.spec;
const globSpec = builtinTools().get("glob")!.spec;

// --- arms ------------------------------------------------------------------

test("openai-responses puts tool schemas on the wire and emits each complete call exactly once", async () => {
  let body: any;
  await fixture(async (req) => {
    body = await req.json();
    return reply(
      ev("response.output_item.added", { output_index: 0, item: { type: "message", id: "msg-1", role: "assistant", status: "in_progress", content: [] } }) +
      ev("response.output_text.delta", { output_index: 0, content_index: 0, delta: "Inspecting" }) +
      ev("response.output_item.added", { output_index: 1, item: fnItem("call-0", "read_file") }) +
      ev("response.output_item.added", { output_index: 2, item: fnItem("call-1", "glob") }) +
      ev("response.function_call_arguments.delta", { output_index: 1, delta: '{"path":"a' }) +
      ev("response.function_call_arguments.delta", { output_index: 2, delta: '{"pattern":' }) +
      ev("response.function_call_arguments.delta", { output_index: 2, delta: '"*.ts"}' }) +
      ev("response.function_call_arguments.delta", { output_index: 1, delta: '.txt"}' }) +
      ev("response.output_item.done", { output_index: 1, item: { ...fnItem("call-0", "read_file", '{"path":"a.txt"}'), status: "completed" } }) +
      ev("response.output_item.done", { output_index: 2, item: { ...fnItem("call-1", "glob", '{"pattern":"*.ts"}'), status: "completed" } }),
    );
  }, async (p) => {
    const chunks: StreamChunk[] = [];
    for await (const c of p.stream({ model: "test", messages: [], tools: [readSpec, globSpec] })) chunks.push(c);
    expect(chunks.filter((c) => c.type === "tool_call")).toEqual([
      { type: "tool_call", id: "call-0|item-call-0", name: "read_file", args: { path: "a.txt" } },
      { type: "tool_call", id: "call-1|item-call-1", name: "glob", args: { pattern: "*.ts" } },
    ]);
    expect(chunks.find((c) => c.type === "delta")).toEqual({ type: "delta", text: "Inspecting" });
    expect(chunks.at(-1)).toEqual({ type: "done", stopReason: "end" });
  });
  expect(body.tools).toEqual([
    expect.objectContaining({ type: "function", name: readSpec.name, description: readSpec.description, parameters: readSpec.inputSchema }),
    expect.objectContaining({ type: "function", name: globSpec.name }),
  ]);
  expect(body.temperature).toBeUndefined();
  expect(body.top_p).toBeUndefined();
  expect(body.reasoning).toBeUndefined();
  expect(body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens).toBe(8192);
});

// The arm that distinguishes this provider from the completions one. The
// Responses adapter seeds the raw-argument buffer from the ADDED item and
// pushes no toolcall_delta for that seed, so a delta-only accumulator reads a
// complete call as a zero-arg one -- and a zero-arg read_file is a plausible,
// silent, WRONG call rather than an error.
test("openai-responses reads arguments delivered whole on the added item, with no deltas", async () => {
  await fixture(() => reply(
    ev("response.output_item.added", { output_index: 0, item: fnItem("call-0", "read_file", '{"path":"seeded.txt"}') }) +
    ev("response.output_item.done", { output_index: 0, item: { ...fnItem("call-0", "read_file", '{"path":"seeded.txt"}'), status: "completed" } }),
  ), async (p) => {
    const calls: StreamChunk[] = [];
    for await (const c of p.stream({ model: "test", messages: [], tools: [readSpec] })) {
      if (c.type === "tool_call") calls.push(c);
    }
    expect(calls).toEqual([{ type: "tool_call", id: "call-0|item-call-0", name: "read_file", args: { path: "seeded.txt" } }]);
  });
});

test("openai-responses treats empty arguments as a zero-arg call ({}), like the anthropic provider", async () => {
  await fixture(() => reply(
    ev("response.output_item.added", { output_index: 0, item: fnItem("call-0", "read_file") }) +
    ev("response.output_item.done", { output_index: 0, item: { ...fnItem("call-0", "read_file"), status: "completed" } }),
  ), async (p) => {
    const calls: StreamChunk[] = [];
    for await (const c of p.stream({ model: "test", messages: [], tools: [readSpec] })) {
      if (c.type === "tool_call") calls.push(c);
    }
    expect(calls).toEqual([{ type: "tool_call", id: "call-0|item-call-0", name: "read_file", args: {} }]);
  });
});

test("openai-responses ignores stray tool events when the caller offered no tools, keeping the text", async () => {
  let body: any;
  await fixture(async (req) => {
    body = await req.json();
    return reply(
      ev("response.output_item.added", { output_index: 0, item: { type: "message", id: "msg-1", role: "assistant", status: "in_progress", content: [] } }) +
      ev("response.output_text.delta", { output_index: 0, content_index: 0, delta: "The answer is 42." }) +
      ev("response.output_item.added", { output_index: 1, item: fnItem("call-0", "list") }) +
      ev("response.output_item.done", { output_index: 1, item: { ...fnItem("call-0", "list"), status: "completed" } }),
    );
  }, async (p) => {
    const seen: StreamChunk[] = [];
    for await (const c of p.stream({ model: "test", messages: [] })) seen.push(c);
    expect(seen.filter((c) => c.type === "tool_call")).toEqual([]);
    expect(seen.find((c) => c.type === "delta")).toEqual({ type: "delta", text: "The answer is 42." });
  });
  expect(body.tools).toBeUndefined();
});

// pi-ai finalizes with parseStreamingJson, which RECOVERS both of these into a
// plausible object. These arms fail on any implementation that reads
// ev.toolCall.arguments instead of re-parsing the raw text strictly.
for (const raw of ['{"path":"a.txt"', '{"path":}']) {
  test(`openai-responses refuses incomplete tool JSON ${JSON.stringify(raw)}`, async () => {
    await fixture(() => reply(
      ev("response.output_item.added", { output_index: 0, item: fnItem("call-0", "read_file") }) +
      ev("response.function_call_arguments.delta", { output_index: 0, delta: raw }) +
      ev("response.output_item.done", { output_index: 0, item: { ...fnItem("call-0", "read_file", raw), status: "completed" } }),
    ), async (p) => {
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

test("openai-responses keeps text-only requests tool-free and abort suppresses buffered calls", async () => {
  let body: any;
  await fixture(async (req) => {
    body = await req.json();
    return reply(
      ev("response.output_item.added", { output_index: 0, item: { type: "message", id: "msg-1", role: "assistant", status: "in_progress", content: [] } }) +
      ev("response.output_text.delta", { output_index: 0, content_index: 0, delta: "first" }) +
      ev("response.output_item.added", { output_index: 1, item: fnItem("call-0", "glob", "{}") }) +
      ev("response.output_item.done", { output_index: 1, item: { ...fnItem("call-0", "glob", "{}"), status: "completed" } }),
    );
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

// --- factory ---------------------------------------------------------------
// The registry deliberately carries NO openai-responses entry yet: per the
// sprint rule, a profile that advertises a tool surface earns it only once a
// live arm has executed a real tool call. The factory branch is still a working
// path and is exercised here on a fixture profile, so it is not dead code.
const responsesFixture: ModelProfile = {
  id: "responses-agent", provider: "openai-responses", model: "test-model",
  baseUrl: "http://127.0.0.1/v1", contextTokens: 32_768, maxToolSurface: 7,
  parser: "native", streamingTools: true, apiKeyEnv: "RAZIEL_COMPAT_KEY",
};

test("providerFor builds the responses provider, and refuses a keyed profile whose var is unset", () => {
  const prev = process.env.RAZIEL_COMPAT_KEY;
  try {
    process.env.RAZIEL_COMPAT_KEY = "test-key";
    expect(providerFor(responsesFixture).name).toBe("openai-responses");
    delete process.env.RAZIEL_COMPAT_KEY;
    expect(() => providerFor(responsesFixture)).toThrow(/requires RAZIEL_COMPAT_KEY/);
    expect(() => providerFor({ ...responsesFixture, baseUrl: undefined })).toThrow(/missing baseUrl/);
  } finally {
    if (prev === undefined) delete process.env.RAZIEL_COMPAT_KEY; else process.env.RAZIEL_COMPAT_KEY = prev;
  }
});

test("the registry advertises no openai-responses profile until a live tool arm exists", () => {
  expect(listProfiles().filter((p) => p.provider === "openai-responses")).toEqual([]);
});
