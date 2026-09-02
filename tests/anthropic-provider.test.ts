import { test, expect } from "bun:test";
import { AnthropicProvider } from "../src/providers/anthropic";

test("constructs without network and implements Provider", () => {
  const p = new AnthropicProvider({ apiKey: "test-key-not-real" });
  expect(p.name).toBe("anthropic");
  expect(typeof p.stream).toBe("function");
});

// --- Fetch-fake harness, mirroring tests/ollama-provider.test.ts's `fakeOk` pattern:
// a custom `fetch` implementation injected into the provider (here via the
// Anthropic SDK's own `fetch` ClientOption) instead of a real network call. ---

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sseStream(events: Array<{ event: string; data: unknown }>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const e of events) controller.enqueue(encoder.encode(sseEvent(e.event, e.data)));
      controller.close();
    },
  });
}

function fakeFetch(events: Array<{ event: string; data: unknown }>): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; body: any }>;
} {
  const calls: Array<{ url: string; body: any }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return new Response(sseStream(events), { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const READ_FILE_TOOL = { name: "read_file", description: "Read a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } };

test("tool_use block with input split across two input_json_delta events yields exactly one tool_call", async () => {
  const events = [
    { event: "message_start", data: { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [], model: "m", stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } } },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "read_file", input: {} } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"' } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'a.txt"}' } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 10 } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
  const { fetchImpl, calls } = fakeFetch(events);
  const p = new AnthropicProvider({ apiKey: "test-key", fetchImpl });

  const toolCalls: Array<{ id: string; name: string; args: unknown }> = [];
  let sawDone = false;
  for await (const c of p.stream({
    model: "claude-test",
    messages: [{ role: "user", content: "read a.txt" }],
    tools: [READ_FILE_TOOL],
  })) {
    if (c.type === "tool_call") toolCalls.push({ id: c.id, name: c.name, args: c.args });
    else if (c.type === "done") sawDone = true;
  }

  expect(toolCalls).toEqual([{ id: "tu_1", name: "read_file", args: { path: "a.txt" } }]);
  expect(sawDone).toBe(true);

  // Request body carries the mapped tools array with the input_schema key.
  expect(calls.length).toBe(1);
  expect(calls[0]!.body.tools).toEqual([
    { name: "read_file", description: "Read a file", input_schema: READ_FILE_TOOL.inputSchema },
  ]);
});

test("invalid accumulated JSON in a tool_use block throws, yielding no tool_call", async () => {
  const events = [
    { event: "message_start", data: { type: "message_start", message: { id: "msg_2", type: "message", role: "assistant", content: [], model: "m", stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } } },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_2", name: "read_file", input: {} } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path": "a.txt"' } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: " garbage not json" } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
  ];
  const { fetchImpl } = fakeFetch(events);
  const p = new AnthropicProvider({ apiKey: "test-key", fetchImpl });

  const toolCalls: unknown[] = [];
  let threw = false;
  try {
    for await (const c of p.stream({
      model: "claude-test",
      messages: [{ role: "user", content: "read a.txt" }],
      tools: [READ_FILE_TOOL],
    })) {
      if (c.type === "tool_call") toolCalls.push(c);
    }
  } catch {
    threw = true;
  }

  expect(threw).toBe(true);
  expect(toolCalls).toEqual([]);
});

test("abort right after the tool_call: no further chunks, no done", async () => {
  const events = [
    { event: "message_start", data: { type: "message_start", message: { id: "msg_3", type: "message", role: "assistant", content: [], model: "m", stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } } },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_3", name: "read_file", input: {} } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"a.txt"}' } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 10 } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
  const { fetchImpl } = fakeFetch(events);
  const p = new AnthropicProvider({ apiKey: "test-key", fetchImpl });

  const ctl = new AbortController();
  const got: unknown[] = [];
  let sawDone = false;
  for await (const c of p.stream({
    model: "claude-test",
    messages: [{ role: "user", content: "read a.txt" }],
    tools: [READ_FILE_TOOL],
    signal: ctl.signal,
  })) {
    if (c.type === "tool_call") {
      got.push(c);
      ctl.abort();
    }
    if (c.type === "done") sawDone = true;
  }

  expect(got.length).toBe(1);
  expect(sawDone).toBe(false);
}, 2000);
