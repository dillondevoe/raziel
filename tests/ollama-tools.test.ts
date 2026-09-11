import { test, expect } from "bun:test";
import type { Provider, StreamChunk, ToolSpec } from "../src/provider";
import { OllamaProvider } from "../src/providers/ollama";

const tools: ToolSpec[] = [{
  name: "read_file",
  description: "Read a workspace file",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
}];
const opts = {
  model: "qwen2.5:7b",
  messages: [{ role: "user" as const, content: "Read src/engine.ts" }],
  contextTokens: 32_768,
  sampling: { temperature: 0.7, topP: 0.8 },
};
const readCall = { function: { name: "read_file", arguments: { path: "src/engine.ts" } } };
const end: StreamChunk = { type: "done", stopReason: "end" };
const noTools: (ToolSpec[] | undefined)[] = [undefined, []];

// Same fragmented NDJSON style as usage-providers.test.ts. These are complete
// native calls with OBJECT arguments, not OpenAI-style argument string deltas.
function ollama(records: object[]) {
  let requestBody: Record<string, unknown> | undefined;
  const text = [...records, { done: true }].map((record) => JSON.stringify(record)).join("\n") + "\n";
  const encoder = new TextEncoder();
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(new ReadableStream({ start(controller) {
      for (let i = 0; i < text.length; i += 11) controller.enqueue(encoder.encode(text.slice(i, i + 11)));
      controller.close();
    } }), { headers: { "content-type": "application/x-ndjson" } });
  }) as unknown as typeof fetch;
  return { provider: new OllamaProvider({ fetchImpl }), body: () => requestBody! };
}

async function collect(provider: Provider, offered?: ToolSpec[]) {
  const chunks: StreamChunk[] = [];
  for await (const chunk of provider.stream({ ...opts, ...(offered === undefined ? {} : { tools: offered }) })) chunks.push(chunk);
  return chunks;
}

test("Ollama declares native function tools without changing qwen options", async () => {
  const fixture = ollama([]);
  await collect(fixture.provider, tools);
  expect(fixture.body().options).toEqual({ num_ctx: 32_768, temperature: 0.7, top_p: 0.8 });
  expect(fixture.body()).toEqual({
    model: opts.model, messages: opts.messages, stream: true,
    options: { num_ctx: 32_768, temperature: 0.7, top_p: 0.8 },
    tools: [{ type: "function", function: {
      name: tools[0]!.name, description: tools[0]!.description, parameters: tools[0]!.inputSchema,
    } }],
  });
});

for (const offered of noTools) {
  test(`Ollama omits the tools key when tools are ${offered === undefined ? "absent" : "empty"}`, async () => {
    const fixture = ollama([]);
    await collect(fixture.provider, offered);
    expect(Object.hasOwn(fixture.body(), "tools")).toBe(false);
    expect(fixture.body().options).toEqual({ num_ctx: 32_768, temperature: 0.7, top_p: 0.8 });
  });
}

test("Ollama emits one native object-argument call and no empty text delta", async () => {
  const { provider } = ollama([{ message: { content: "", tool_calls: [{ id: "call_read", ...readCall }] } }]);
  const chunks = await collect(provider, tools);
  expect(chunks.filter((chunk) => chunk.type === "delta")).toEqual([]);
  expect(chunks).toEqual([
    { type: "tool_call", id: "call_read", name: "read_file", args: { path: "src/engine.ts" } }, end,
  ]);
});

test("Ollama emits two calls in message array order, keeping accompanying text", async () => {
  const { provider } = ollama([{ message: { content: "Reading both", tool_calls: [
    { id: "call_z", ...readCall },
    { id: "call_a", function: { name: "read_file", arguments: { path: "src/provider.ts" } } },
  ] } }]);
  expect(await collect(provider, tools)).toEqual([
    { type: "delta", text: "Reading both" },
    { type: "tool_call", id: "call_z", name: "read_file", args: { path: "src/engine.ts" } },
    { type: "tool_call", id: "call_a", name: "read_file", args: { path: "src/provider.ts" } }, end,
  ]);
});

test("Ollama generates unique missing ids per call, stable as the stream drains", async () => {
  const { provider } = ollama([
    { message: { content: "", tool_calls: [readCall, readCall] } },
    { message: { content: "", tool_calls: [readCall] } },
  ]);
  const calls: Extract<StreamChunk, { type: "tool_call" }>[] = [];
  const idsAtEmission: string[] = [];
  for await (const chunk of provider.stream({ ...opts, tools })) {
    if (chunk.type === "tool_call") {
      calls.push(chunk);
      idsAtEmission.push(chunk.id);
    }
  }
  expect(calls).toHaveLength(3);
  for (const call of calls) {
    expect(typeof call.id).toBe("string");
    expect(call.id.length).toBeGreaterThan(0);
    expect(call).toEqual({ type: "tool_call", id: call.id, name: "read_file", args: { path: "src/engine.ts" } });
  }
  expect(new Set(idsAtEmission).size).toBe(3);
  expect(calls.map((call) => call.id)).toEqual(idsAtEmission);
});

test("Ollama preserves a supplied wire id alongside an id-less call", async () => {
  const { provider } = ollama([{ message: { content: "", tool_calls: [readCall, { id: "call_wire", ...readCall }] } }]);
  const calls = (await collect(provider, tools)).filter((chunk) => chunk.type === "tool_call");
  expect(calls).toHaveLength(2);
  expect(calls[1]!.id).toBe("call_wire");
  expect(calls[0]!.id).not.toBe(calls[1]!.id);
});

for (const offered of noTools) {
  test(`Ollama ignores unsolicited calls and keeps text when tools are ${offered === undefined ? "absent" : "empty"}`, async () => {
    const { provider } = ollama([{ message: { content: "Plain reply", tool_calls: [{ id: "call_stray", ...readCall }] } }]);
    expect(await collect(provider, offered)).toEqual([{ type: "delta", text: "Plain reply" }, end]);
  });
}
