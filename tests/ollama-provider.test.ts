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
