import { expect, test } from "bun:test";
import { AnthropicProvider } from "../src/providers/anthropic";

// Live exhibit 2026-09-12 (session sonnet-ships-1, round 3): output_tokens 8192 = reasoning_tokens 8192,
// stop_reason max_tokens, ZERO text and ZERO tool calls — and the door yielded { done, "end" }, so the
// engine persisted an empty assistant_message and closed the turn as a clean end. A round that produced
// nothing visible because the budget ran out is an error the operator must see, never a quiet end.
function providerWith(events: any[]) {
  const fetchImpl = (async () => new Response(
    events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
  return new AnthropicProvider({ apiKey: "test-key", fetchImpl });
}
const start = { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } };

test("max_tokens with no visible output THROWS, naming the budget and the reasoning spend", async () => {
  const p = providerWith([
    start,
    { type: "message_delta", delta: { stop_reason: "max_tokens", stop_sequence: null }, usage: { output_tokens: 8192, output_tokens_details: { thinking_tokens: 8192 } } },
    { type: "message_stop" },
  ]);
  let err: unknown = null;
  const seen: string[] = [];
  try { for await (const c of p.stream({ model: "fake", messages: [{ role: "user", content: "x" }] })) seen.push(c.type); }
  catch (e) { err = e; }
  expect(err).toBeInstanceOf(Error);
  const msg = (err as Error).message;
  expect(msg).toContain("max_tokens");
  expect(msg).toContain("8192");
  expect(msg).toContain("reasoning");
  expect(seen).not.toContain("done");
});

test("max_tokens WITH visible text is reported as done/length, not end (positive control for the throw)", async () => {
  const p = providerWith([
    start,
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "max_tokens", stop_sequence: null }, usage: { output_tokens: 8192 } },
    { type: "message_stop" },
  ]);
  const chunks: any[] = [];
  for await (const c of p.stream({ model: "fake", messages: [{ role: "user", content: "x" }] })) chunks.push(c);
  expect(chunks.some(c => c.type === "delta" && c.text === "partial")).toBe(true);
  const done = chunks.find(c => c.type === "done");
  expect(done?.stopReason).toBe("length");
});

test("end_turn with text is a clean end (negative control)", async () => {
  const p = providerWith([
    start,
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ]);
  const chunks: any[] = [];
  for await (const c of p.stream({ model: "fake", messages: [{ role: "user", content: "x" }] })) chunks.push(c);
  expect(chunks.find(c => c.type === "done")?.stopReason).toBe("end");
});

test("the request asks for more than 8192 output tokens (a thinking model can spend 8k on reasoning alone)", async () => {
  const bodies: any[] = [];
  const fetchImpl = (async (input: any, init?: any) => {
    const request = input instanceof Request ? input : new Request(input, init);
    bodies.push(await request.json());
    return new Response([start, { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }, { type: "message_stop" }]
      .map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  const p = new AnthropicProvider({ apiKey: "test-key", fetchImpl });
  for await (const _ of p.stream({ model: "fake", messages: [{ role: "user", content: "x" }] })) {}
  expect(bodies[0].max_tokens).toBeGreaterThan(8192);
});
