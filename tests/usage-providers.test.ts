import { test, expect } from "bun:test";
import { AnthropicProvider } from "../src/providers/anthropic";
import { OpenAICompatProvider } from "../src/providers/openai_compat";
import { OllamaProvider } from "../src/providers/ollama";
import type { Provider, StreamChunk } from "../src/provider";

async function collect(provider: Provider) {
  const chunks: StreamChunk[] = [];
  for await (const chunk of provider.stream({ model: "fixture-model", messages: [{ role: "user", content: "hi" }] })) chunks.push(chunk);
  return chunks.filter((c) => c.type === "usage");
}

function anthropic(startUsage?: object, deltas: object[] = []) {
  const events = [
    { type: "message_start", message: { id: "fixture", type: "message", role: "assistant", content: [], model: "fixture-model", stop_reason: null, stop_sequence: null, ...(startUsage ? { usage: startUsage } : {}) } },
    ...deltas.map((usage) => ({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage })),
    { type: "message_stop" },
  ];
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  const fetchImpl = (async () => new Response(body, { headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
  return new AnthropicProvider({ apiKey: "fixture-key", fetchImpl });
}

test("Anthropic SDK merges cumulative message_start/message_delta usage, including cache and thinking", async () => {
  const provider = anthropic(
    { input_tokens: 50, output_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
    [{ input_tokens: 60, output_tokens: 8, cache_read_input_tokens: 20, cache_creation_input_tokens: 6 },
     { output_tokens: 15, output_tokens_details: { thinking_tokens: 4 } }],
  );
  expect(await collect(provider)).toEqual([{ type: "usage", usage: { input_tokens: 60, output_tokens: 15, reasoning_tokens: 4, cache_read_tokens: 20, cache_write_tokens: 6 } }]);
});

test("Anthropic preserves reported zeros and omits unavailable optional fields", async () => {
  expect(await collect(anthropic({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: null }))).toEqual([
    { type: "usage", usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 } },
  ]);
});

test("Anthropic without usage emits nothing", async () => {
  expect(await collect(anthropic())).toEqual([]);
});

async function compat(usage: object | null | undefined, check: (provider: Provider, body: () => any) => Promise<void>, choiceUsage = false) {
  let requestBody: any;
  const server = Bun.serve({ port: 0, async fetch(req) {
    requestBody = await req.json();
    const chunk = (choices: unknown[], extra: object = {}) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices, ...extra })}\n\n`;
    const finish = { index: 0, delta: { content: "reply" }, finish_reason: "stop", ...(choiceUsage ? { usage } : {}) };
    return new Response(chunk([finish]) + (choiceUsage ? "" : chunk([], { usage })) + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  } });
  try { await check(new OpenAICompatProvider({ baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "fixture-key" }), () => requestBody); }
  finally { server.stop(true); }
}

test("compat requests include_usage and uses pi-ai's parsed final chunk, excluding cache from input and keeping reasoning inside output", async () => {
  await compat({ prompt_tokens: 100, completion_tokens: 15, total_tokens: 115, prompt_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 }, completion_tokens_details: { reasoning_tokens: 4 } }, async (provider, body) => {
    expect(await collect(provider)).toEqual([{ type: "usage", usage: { input_tokens: 70, output_tokens: 15, reasoning_tokens: 4, cache_read_tokens: 20, cache_write_tokens: 10 } }]);
    expect(body().stream_options).toEqual({ include_usage: true });
  });
});

for (const usage of [undefined, null]) {
  test(`compat missing usage (${usage}) must not turn pi-ai's zero placeholder into a measurement`, async () => {
    await compat(usage, async (provider) => { expect(await collect(provider)).toEqual([]); });
  });
}

test("compat reports an explicit all-zero total, without inventing optional zero breakdowns", async () => {
  await compat({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, async (provider) => {
    expect(await collect(provider)).toEqual([{ type: "usage", usage: { input_tokens: 0, output_tokens: 0 } }]);
  });
});

test("compat reuses pi-ai's choice.usage and cache-hit fallback mapping", async () => {
  await compat({ prompt_tokens: 100, completion_tokens: 15, prompt_cache_hit_tokens: 30 }, async (provider) => {
    expect(await collect(provider)).toEqual([{ type: "usage", usage: { input_tokens: 70, output_tokens: 15, cache_read_tokens: 30 } }]);
  }, true);
});

function ollama(final: object, newline = true) {
  const text = JSON.stringify({ done: false, message: { content: "reply" }, prompt_eval_count: 999, eval_count: 999 }) + "\n" + JSON.stringify({ done: true, ...final }) + (newline ? "\n" : "");
  const encoder = new TextEncoder();
  const fetchImpl = (async () => new Response(new ReadableStream({ start(controller) {
    // Split inside both JSON and the final usage record.
    for (let i = 0; i < text.length; i += 11) controller.enqueue(encoder.encode(text.slice(i, i + 11)));
    controller.close();
  } }))) as unknown as typeof fetch;
  return new OllamaProvider({ fetchImpl });
}

for (const newline of [true, false]) {
  test(`Ollama maps counts only from the final NDJSON record (trailing newline=${newline})`, async () => {
    expect(await collect(ollama({ prompt_eval_count: 70, eval_count: 15 }, newline))).toEqual([{ type: "usage", usage: { input_tokens: 70, output_tokens: 15 } }]);
  });
}

test("Ollama retains reported zeros", async () => {
  expect(await collect(ollama({ prompt_eval_count: 0, eval_count: 0 }))).toEqual([{ type: "usage", usage: { input_tokens: 0, output_tokens: 0 } }]);
});

for (const final of [{}, { prompt_eval_count: 2 }, { eval_count: 3 }, { prompt_eval_count: null, eval_count: 3 }]) {
  test(`Ollama omits missing/incomplete usage ${JSON.stringify(final)}`, async () => {
    expect(await collect(ollama(final))).toEqual([]);
  });
}
