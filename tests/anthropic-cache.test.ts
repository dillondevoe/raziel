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
  test(`cache positions are exactly last system, last tool and stable prefix (${apiKey})`, async () => {
    const h = harness(apiKey);
    const before = structuredClone({ exchange, tools });
    const body = await h.send(exchange, "Fixed persona", tools);
    const lastSystem = apiKey.startsWith("sk-ant-oat") ? 1 : 0;
    expect(breakpoints(body)).toEqual([
      `.system.${lastSystem}.cache_control`, ".messages.1.content.0.cache_control", ".tools.1.cache_control",
    ]);
    expect(body.system[lastSystem]).toEqual({ type: "text", text: "Fixed persona", cache_control: cache });
    expect(body.tools[1].cache_control).toEqual(cache);
    expect(body.messages[1].content[0]).toEqual({ type: "text", text: "old answer", cache_control: cache });
    expect(body.messages[2]).toEqual({ role: "user", content: "current question" });
    if (lastSystem === 1) expect(body.system[0]).toEqual({ type: "text", text: CLAUDE_CODE_IDENTITY });
    expect({ exchange, tools }).toEqual(before);
  });
}

test("single user with later tool rounds has no message breakpoint; zero to two static breakpoints", async () => {
  for (const apiKey of ["test-key", "sk-ant-oat01-test"]) {
    for (const system of [undefined, "Fixed"]) {
      for (const offered of [undefined, [], tools]) {
        const h = harness(apiKey);
        for (const messages of [[exchange[2]!], exchange.slice(2)]) {
          const body = await h.send(messages, system, offered);
          expect(breakpoints(body.messages)).toEqual([]);
          expect(breakpoints(body).length).toBeLessThanOrEqual(2);
          expect(breakpoints(body).length).toBe(Number(!!system || apiKey.startsWith("sk-ant-oat")) + Number(!!offered?.length));
          if (apiKey.startsWith("sk-ant-oat") && !system) {
            expect(body.system).toEqual([{ type: "text", text: CLAUDE_CODE_IDENTITY, cache_control: cache }]);
          }
        }
      }
    }
  }
});

test("stable prefix boundary is found before mapping drops empty assistants, not at tool-result user roles", async () => {
  const h = harness();
  const body = await h.send([
    ...exchange,
    { role: "assistant", content: "" },
    { role: "user", content: "next turn" },
  ]);
  expect(breakpoints(body)).toEqual([".messages.4.content.0.cache_control"]);
  expect(body.messages[4].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "c", cache_control: cache });
  expect(body.messages[5].content).toBe("next turn");
});

test("string prefix is converted to a block and only last content block is marked", async () => {
  const h = harness();
  const strings = await h.send([{ role: "user", content: "previous" }, { role: "user", content: "newest" }]);
  expect(strings.messages[0].content).toEqual([{ type: "text", text: "previous", cache_control: cache }]);
  const blocks = await h.send([
    { role: "user", content: "old" },
    { role: "assistant", content: "prose", toolCalls: [{ id: "c", name: "read_file", args: {} }] },
    { role: "user", content: "newest" },
  ]);
  expect(breakpoints(blocks)).toEqual([".messages.1.content.1.cache_control"]);
});

test("absent newest user means no message breakpoint, and all combinations stay at most three", async () => {
  const h = harness();
  expect(breakpoints(await h.send([{ role: "assistant", content: "only" }]))).toEqual([]);
  for (const messages of [[], [exchange[0]!], exchange]) {
    for (const system of [undefined, "fixed"]) {
      for (const offered of [undefined, tools]) {
        expect(breakpoints(await h.send(messages, system, offered)).length).toBeLessThanOrEqual(3);
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
