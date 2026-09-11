import { expect, test } from "bun:test";
import { AnthropicProvider, CLAUDE_CODE_IDENTITY } from "../src/providers/anthropic";
import type { ChatMessage, ToolSpec } from "../src/provider";

const cache = { type: "ephemeral" };
const tools: ToolSpec[] = [
  { name: "read_file", description: "Read", inputSchema: { type: "object" } },
  { name: "grep", description: "Search", inputSchema: { type: "object" } },
];
function harness(apiKey = "test-key") {
  const bodies: any[] = [];
  const fetchImpl = (async (input: any, init?: any) => {
    const request = input instanceof Request ? input : new Request(input, init);
    bodies.push(await request.json());
    const events = [
      { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "hi" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  const provider = new AnthropicProvider({ apiKey, fetchImpl });
  return { bodies, async send(messages: ChatMessage[], system?: string, offered?: ToolSpec[]) {
    for await (const _ of provider.stream({ model: "fake", messages, system, tools: offered })) {}
    return bodies.at(-1);
  } };
}
function breakpoints(value: any, path = ""): string[] {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => key === "cache_control"
    ? [path + ".cache_control"] : breakpoints(child, path + "." + key));
}
const exchange: ChatMessage[] = [
  { role: "user", content: "old question" },
  { role: "assistant", content: "old answer" },
  { role: "user", content: "current question" },
  { role: "assistant", content: "", toolCalls: [{ id: "c", name: "read_file", args: { path: "a" } }] },
  { role: "tool", results: [{ id: "c", name: "read_file", ok: true, output: "bytes" }] },
];

for (const apiKey of ["test-key", "sk-ant-oat01-test"]) {
  test(`cache positions are exactly last system, last tool and the message tail (${apiKey})`, async () => {
    const h = harness(apiKey);
    const before = structuredClone({ exchange, tools });
    const body = await h.send(exchange, "Fixed persona", tools);
    const lastSystem = apiKey.startsWith("sk-ant-oat") ? 1 : 0;
    expect(breakpoints(body)).toEqual([
      `.system.${lastSystem}.cache_control`, ".messages.4.content.0.cache_control", ".tools.1.cache_control",
    ]);
    expect(body.system[lastSystem]).toEqual({ type: "text", text: "Fixed persona", cache_control: cache });
    expect(body.tools[1].cache_control).toEqual(cache);
    expect(body.messages[1].content).toBe("old answer");
    expect(body.messages[2]).toEqual({ role: "user", content: "current question" });
    expect(body.messages[4].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "c", cache_control: cache });
    if (lastSystem === 1) expect(body.system[0]).toEqual({ type: "text", text: CLAUDE_CODE_IDENTITY });
    expect({ exchange, tools }).toEqual(before);
  });
}

// Geist, after the gate: the third breakpoint sits on the LAST block of the
// LAST message, so the cached prefix GROWS every tool round. The first cut
// pinned it before the newest user message (Geist's own spec error) and left
// every round inside a tool turn uncached until the next turn.
test("the message breakpoint is on the tail: last block of the last message, whatever its kind", async () => {
  const h = harness();
  // tail is a tool_result block (mid-tool-turn)
  const mid = await h.send(exchange);
  expect(breakpoints(mid.messages)).toEqual([".4.content.0.cache_control"]);
  expect(mid.messages[4].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "c", cache_control: cache });
  // tail is a plain user string → converted to one text block, marked
  const fresh = await h.send([{ role: "user", content: "previous" }, { role: "user", content: "newest" }]);
  expect(fresh.messages[0].content).toBe("previous");
  expect(fresh.messages[1].content).toEqual([{ type: "text", text: "newest", cache_control: cache }]);
  // tail is an assistant with tool_use → the tool_use block is marked, the text block is not
  const call = await h.send([
    { role: "user", content: "old" },
    { role: "assistant", content: "prose", toolCalls: [{ id: "c", name: "read_file", args: {} }] },
  ]);
  expect(breakpoints(call.messages)).toEqual([".1.content.1.cache_control"]);
  // an empty trailing assistant is dropped by the mapper; the breakpoint lands on what remains
  const dropped = await h.send([...exchange, { role: "assistant", content: "" }]);
  expect(breakpoints(dropped.messages)).toEqual([".4.content.0.cache_control"]);
});

test("the prefix grows round over round: round N's marked tail is round N+1's unmarked history", async () => {
  const h = harness();
  const r1 = await h.send(exchange.slice(0, 3));
  const r2 = await h.send(exchange);
  // what was the tail (and marked) in r1 is now plain in r2, and the mark moved to the new tail
  expect(breakpoints(r1.messages)).toEqual([".2.content.0.cache_control"]);
  expect(r2.messages[2].content).toBe("current question");
  expect(breakpoints(r2.messages)).toEqual([".4.content.0.cache_control"]);
});

test("no messages means no message breakpoint; every combination stays at most three", async () => {
  const h = harness();
  expect(breakpoints((await h.send([])).messages ?? [])).toEqual([]);
  for (const messages of [[], [exchange[0]!], exchange]) {
    for (const system of [undefined, "fixed"]) {
      for (const offered of [undefined, tools]) {
        const body = await h.send(messages, system, offered);
        expect(breakpoints(body).length).toBeLessThanOrEqual(3);
        expect(breakpoints(body).length).toBe(Number(!!system) + Number(!!offered?.length) + Number(messages.length > 0));
      }
    }
  }
});

test("consecutive rounds have byte-identical system and tools request fields with the same inputs", async () => {
  const h = harness("sk-ant-oat01-test");
  const first = await h.send(exchange.slice(0, 3), "Fixed persona", tools);
  const second = await h.send(exchange, "Fixed persona", tools);
  expect(JSON.stringify({ system: second.system, tools: second.tools })).toBe(JSON.stringify({ system: first.system, tools: first.tools }));
});
