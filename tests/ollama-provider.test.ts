import { test, expect } from "bun:test";
import { OllamaProvider } from "../src/providers/ollama";

function ndjsonStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line + "\n"));
      controller.close();
    },
  });
}

function fakeOk(lines: string[]): { fetchImpl: typeof fetch; calls: Array<{ url: string; body: any }> } {
  const calls: Array<{ url: string; body: any }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return new Response(ndjsonStream(lines), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

test("happy path: two content chunks then done, num_ctx defaults to 32768", async () => {
  const lines = [
    JSON.stringify({ message: { role: "assistant", content: "He" }, done: false }),
    JSON.stringify({ message: { role: "assistant", content: "y" }, done: false }),
    JSON.stringify({ done: true }),
  ];
  const { fetchImpl, calls } = fakeOk(lines);
  const p = new OllamaProvider({ fetchImpl });
  const deltas: string[] = [];
  let sawDone = false;
  for await (const c of p.stream({ model: "qwen3.5:9b", messages: [{ role: "user", content: "hi" }] })) {
    if (c.type === "delta") deltas.push(c.text);
    else { sawDone = true; expect(c.stopReason).toBe("end"); }
  }
  expect(deltas).toEqual(["He", "y"]);
  expect(sawDone).toBe(true);

  expect(calls.length).toBe(1);
  expect(calls[0]!.url).toBe("http://127.0.0.1:11434/api/chat");
  expect(calls[0]!.body.model).toBe("qwen3.5:9b");
  expect(calls[0]!.body.stream).toBe(true);
  expect(calls[0]!.body.options.num_ctx).toBe(32768);
  expect(calls[0]!.body.messages).toEqual([{ role: "user", content: "hi" }]);
});

test("system prompt prepended as a system message", async () => {
  const lines = [JSON.stringify({ done: true })];
  const { fetchImpl, calls } = fakeOk(lines);
  const p = new OllamaProvider({ fetchImpl });
  for await (const _ of p.stream({ model: "m", system: "be terse", messages: [{ role: "user", content: "hi" }] })) {
    // drain
  }
  expect(calls[0]!.body.messages).toEqual([
    { role: "system", content: "be terse" },
    { role: "user", content: "hi" },
  ]);
});

test("contextTokens honored when passed", async () => {
  const lines = [JSON.stringify({ done: true })];
  const { fetchImpl, calls } = fakeOk(lines);
  const p = new OllamaProvider({ fetchImpl });
  for await (const _ of p.stream({ model: "m", messages: [], contextTokens: 8192 })) {
    // drain
  }
  expect(calls[0]!.body.options.num_ctx).toBe(8192);
});

test("sampling maps temperature/topP to options", async () => {
  const lines = [JSON.stringify({ done: true })];
  const { fetchImpl, calls } = fakeOk(lines);
  const p = new OllamaProvider({ fetchImpl });
  for await (const _ of p.stream({
    model: "m",
    messages: [],
    sampling: { temperature: 0.7, topP: 0.8 },
  })) {
    // drain
  }
  expect(calls[0]!.body.options.temperature).toBe(0.7);
  expect(calls[0]!.body.options.top_p).toBe(0.8);
});

test("abort mid-stream: no further chunks, no done", async () => {
  const lines = [
    JSON.stringify({ message: { role: "assistant", content: "a" }, done: false }),
    JSON.stringify({ message: { role: "assistant", content: "b" }, done: false }),
    JSON.stringify({ message: { role: "assistant", content: "c" }, done: false }),
    JSON.stringify({ done: true }),
  ];
  const { fetchImpl } = fakeOk(lines);
  const p = new OllamaProvider({ fetchImpl });
  const ctl = new AbortController();
  const got: string[] = [];
  let sawDone = false;
  for await (const c of p.stream({ model: "m", messages: [], signal: ctl.signal })) {
    if (c.type === "delta") { got.push(c.text); ctl.abort(); }
    if (c.type === "done") sawDone = true;
  }
  expect(got).toEqual(["a"]);
  expect(sawDone).toBe(false);
});

test("HTTP 500 with body throws with body text in the message", async () => {
  const fetchImpl = (async () => new Response("internal boom", { status: 500 })) as unknown as typeof fetch;
  const p = new OllamaProvider({ fetchImpl });
  await expect(async () => {
    for await (const _ of p.stream({ model: "m", messages: [] })) {
      // should throw before/while yielding
    }
  }).toThrow(/internal boom/);
});

test("default baseUrl is 127.0.0.1:11434 when not specified", async () => {
  const lines = [JSON.stringify({ done: true })];
  const { fetchImpl, calls } = fakeOk(lines);
  const p = new OllamaProvider({ fetchImpl });
  for await (const _ of p.stream({ model: "m", messages: [] })) {
    // drain
  }
  expect(calls[0]!.url).toBe("http://127.0.0.1:11434/api/chat");
});

test("fetch is invoked with the given abort signal (identity)", async () => {
  const ctl = new AbortController();
  const lines = [JSON.stringify({ done: true })];
  let capturedSignal: AbortSignal | undefined;
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    capturedSignal = init?.signal ?? undefined;
    return new Response(ndjsonStream(lines), { status: 200 });
  }) as unknown as typeof fetch;
  const p = new OllamaProvider({ fetchImpl });
  for await (const _ of p.stream({ model: "m", messages: [], signal: ctl.signal })) {
    // drain
  }
  // Identity, not just presence — deleting the `signal: opts.signal` pass-through
  // would leave this undefined (or some other signal) and fail the assertion.
  expect(capturedSignal).toBe(ctl.signal);
});

test("abort while reader.read() is pending returns cleanly — no throw, no done", async () => {
  // Simulates ollama's real behavior: fetch's AbortSignal rejects an in-flight
  // body read with a DOMException("AbortError") once the signal fires.
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal;
    const reader = {
      read: () =>
        new Promise<{ done: boolean; value?: Uint8Array }>((_resolve, reject) => {
          if (signal?.aborted) {
            reject(new DOMException("The operation was aborted", "AbortError"));
            return;
          }
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("The operation was aborted", "AbortError")),
            { once: true },
          );
          // otherwise: never resolves — the read is left pending until abort
        }),
    };
    const body = { getReader: () => reader };
    return { ok: true, status: 200, body } as unknown as Response;
  }) as unknown as typeof fetch;

  const p = new OllamaProvider({ fetchImpl });
  const ctl = new AbortController();
  const chunks: unknown[] = [];

  const iterate = (async () => {
    for await (const c of p.stream({ model: "m", messages: [], signal: ctl.signal })) {
      chunks.push(c);
    }
  })();

  // Let the generator reach the pending read() before aborting.
  await new Promise((r) => setTimeout(r, 0));
  ctl.abort();

  await expect(iterate).resolves.toBeUndefined();
  expect(chunks).toEqual([]);
});

test("mid-object NDJSON chunk split across two reads reassembles correctly", async () => {
  const fullLine = JSON.stringify({ message: { role: "assistant", content: "Hey" }, done: false }) + "\n";
  const doneLine = JSON.stringify({ done: true }) + "\n";
  const fullText = fullLine + doneLine;
  const splitAt = 12; // lands mid-object, well before the line's closing brace
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(fullText.slice(0, splitAt)));
      controller.enqueue(encoder.encode(fullText.slice(splitAt)));
      controller.close();
    },
  });
  const fetchImpl = (async () => new Response(stream, { status: 200 })) as unknown as typeof fetch;
  const p = new OllamaProvider({ fetchImpl });
  const deltas: string[] = [];
  let sawDone = false;
  for await (const c of p.stream({ model: "m", messages: [] })) {
    if (c.type === "delta") deltas.push(c.text);
    else sawDone = true;
  }
  expect(deltas).toEqual(["Hey"]);
  expect(sawDone).toBe(true);
});

test("malformed NDJSON line rejects with the line text in the message", async () => {
  const lines = ["not valid json"];
  const { fetchImpl } = fakeOk(lines);
  const p = new OllamaProvider({ fetchImpl });
  await expect(async () => {
    for await (const _ of p.stream({ model: "m", messages: [] })) {
      // should throw before/while yielding
    }
  }).toThrow(/not valid json/);
});
