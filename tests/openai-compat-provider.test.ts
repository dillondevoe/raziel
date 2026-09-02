import { test, expect } from "bun:test";
import { OpenAICompatProvider, mapEvent } from "../src/providers/openai_compat";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";

function sseChunk(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function makeChatChunk(delta: Record<string, unknown>, finishReason: string | null = null) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "test-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

async function withFakeServer(
  handler: (req: Request) => Promise<Response> | Response,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = Bun.serve({ port: 0, fetch: (req) => handler(req) });
  try {
    await run(`http://127.0.0.1:${server.port}/v1`);
  } finally {
    server.stop(true);
  }
}

test("two content deltas + [DONE] map to delta chunks then a final done, and the request caps max tokens", async () => {
  let capturedBody: Record<string, unknown> | undefined;
  await withFakeServer(
    async (req) => {
      capturedBody = (await req.json()) as Record<string, unknown>;
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(sseChunk(makeChatChunk({ role: "assistant", content: "Hel" }))));
          controller.enqueue(encoder.encode(sseChunk(makeChatChunk({ content: "lo" }))));
          controller.enqueue(encoder.encode(sseChunk(makeChatChunk({}, "stop"))));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    },
    async (baseUrl) => {
      const p = new OpenAICompatProvider({ baseUrl, apiKey: "test-key" });
      const deltas: string[] = [];
      let sawDone = false;
      for await (const c of p.stream({ model: "test-model", messages: [{ role: "user", content: "hi" }] })) {
        if (c.type === "delta") deltas.push(c.text);
        else {
          sawDone = true;
          expect(c.stopReason).toBe("end");
        }
      }
      expect(deltas.join("")).toBe("Hello");
      expect(sawDone).toBe(true);
    },
  );

  // Regression: DEFAULT_MAX_TOKENS was set on Model.maxTokens only, which pi-ai's
  // buildParams never reads for the max-tokens field (it reads StreamOptions.maxTokens) —
  // so no cap reached the wire. Assert on whichever field name pi-ai emits for this
  // (unrecognized, so generic-compat) baseUrl.
  expect(capturedBody).toBeDefined();
  const maxTokensValue = capturedBody?.max_tokens ?? capturedBody?.max_completion_tokens;
  expect(maxTokensValue).toBe(8192);
});

test("401 JSON error response rejects the async iteration (THROW path)", async () => {
  await withFakeServer(
    () =>
      new Response(JSON.stringify({ error: { message: "invalid api key", type: "invalid_request_error" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    async (baseUrl) => {
      const p = new OpenAICompatProvider({ baseUrl, apiKey: "bad-key" });
      await expect(async () => {
        for await (const _ of p.stream({ model: "test-model", messages: [{ role: "user", content: "hi" }] })) {
          // should throw before/while yielding
        }
      }).toThrow();
    },
  );
});

test("abort after first delta: no further chunks, no done", async () => {
  await withFakeServer(
    () => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(sseChunk(makeChatChunk({ role: "assistant", content: "a" }))));
          // Only reachable if the client failed to actually abort the request.
          setTimeout(() => {
            try {
              controller.enqueue(encoder.encode(sseChunk(makeChatChunk({ content: "b" }))));
              controller.enqueue(encoder.encode(sseChunk(makeChatChunk({}, "stop"))));
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            } catch {
              // stream already torn down client-side — expected once aborted
            }
          }, 300);
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    },
    async (baseUrl) => {
      const p = new OpenAICompatProvider({ baseUrl, apiKey: "test-key" });
      const ctl = new AbortController();
      const got: string[] = [];
      let sawDone = false;
      for await (const c of p.stream({
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
        signal: ctl.signal,
      })) {
        if (c.type === "delta") {
          got.push(c.text);
          ctl.abort();
        }
        if (c.type === "done") sawDone = true;
      }
      expect(got).toEqual(["a"]);
      expect(sawDone).toBe(false);
    },
  );
}, 2000);

test("abort right after the first delta with the rest of the burst already buffered: no further chunks, no done (I2)", async () => {
  await withFakeServer(
    () => {
      const encoder = new TextEncoder();
      // Twin of ollama-provider.test.ts's abort test: every event enqueued
      // synchronously in one burst (no setTimeout), so by the time our
      // consumer calls ctl.abort() after the first delta, the remaining
      // events are already sitting in pi-ai's internal event queue.
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(sseChunk(makeChatChunk({ role: "assistant", content: "a" }))));
          controller.enqueue(encoder.encode(sseChunk(makeChatChunk({ content: "b" }))));
          controller.enqueue(encoder.encode(sseChunk(makeChatChunk({}, "stop"))));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    },
    async (baseUrl) => {
      const p = new OpenAICompatProvider({ baseUrl, apiKey: "test-key" });
      const ctl = new AbortController();
      const got: string[] = [];
      let sawDone = false;
      for await (const c of p.stream({
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
        signal: ctl.signal,
      })) {
        if (c.type === "delta") {
          got.push(c.text);
          ctl.abort();
        }
        if (c.type === "done") sawDone = true;
      }
      expect(got).toEqual(["a"]);
      expect(sawDone).toBe(false);
    },
  );
}, 2000);

// --- mapEvent unit coverage (event-mapping layer, verbatim pi-ai event shapes) ---
// Belt-and-suspenders alongside the fake-server route above: exercises contentIndex
// interleaving and the thinking_*/toolcall_* ignore-path directly, which the fake
// server above never emits.

function assistantPartial(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "openai-compat",
    model: "test-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "pending",
    timestamp: Date.now(),
    ...overrides,
  } as any;
}

test("mapEvent: text_delta -> delta chunk, keyed by contentIndex (interleaved blocks)", () => {
  const ev: AssistantMessageEvent = { type: "text_delta", contentIndex: 2, delta: "chunk", partial: assistantPartial() };
  expect(mapEvent(ev)).toEqual({ kind: "chunk", chunk: { type: "delta", text: "chunk" } });
});

test("mapEvent: done -> {type:done, stopReason:end} regardless of pi-ai's own reason", () => {
  const ev: AssistantMessageEvent = { type: "done", reason: "stop", message: assistantPartial({ stopReason: "stop" }) };
  expect(mapEvent(ev)).toEqual({ kind: "chunk", chunk: { type: "done", stopReason: "end" } });
});

test("mapEvent: error/aborted -> skip (silent, no throw)", () => {
  const ev: AssistantMessageEvent = {
    type: "error",
    reason: "aborted",
    error: assistantPartial({ stopReason: "aborted" }),
  };
  expect(mapEvent(ev)).toEqual({ kind: "skip" });
});

test("mapEvent: error/error -> throw carrying the provider's errorMessage", () => {
  const ev: AssistantMessageEvent = {
    type: "error",
    reason: "error",
    error: assistantPartial({ stopReason: "error", errorMessage: "500 boom" }),
  };
  const r = mapEvent(ev);
  expect(r.kind).toBe("throw");
  if (r.kind === "throw") expect(r.error.message).toBe("500 boom");
});

test("mapEvent: thinking_delta and toolcall_delta are ignored (M1a ignores non-text blocks)", () => {
  const thinking: AssistantMessageEvent = { type: "thinking_delta", contentIndex: 0, delta: "hmm", partial: assistantPartial() };
  const tool: AssistantMessageEvent = { type: "toolcall_delta", contentIndex: 1, delta: "{}", partial: assistantPartial() };
  expect(mapEvent(thinking)).toEqual({ kind: "skip" });
  expect(mapEvent(tool)).toEqual({ kind: "skip" });
});
