import { describe, expect, test } from "bun:test";
import { FakeProvider } from "../src/providers/fake";
import type { StreamChunk, ToolSpec } from "../src/provider";

describe("provider contract v2", () => {
  test("FakeProvider can script a tool_call chunk and logs tools opt", async () => {
    const p = new FakeProvider([]);
    p.scriptTool("read_file", { path: "a.txt" });
    const tools: ToolSpec[] = [{ name: "read_file", description: "read", inputSchema: { type: "object" } }];
    const chunks: StreamChunk[] = [];
    for await (const c of p.stream({ model: "fake", messages: [{ role: "user", content: "hi" }], tools })) {
      chunks.push(c);
    }
    const call = chunks.find((c) => c.type === "tool_call");
    expect(call && call.type === "tool_call" ? call.name : null).toBe("read_file");
    expect(call && call.type === "tool_call" ? call.args : null).toEqual({ path: "a.txt" });
    expect(typeof (call && call.type === "tool_call" ? call.id : 0)).toBe("string");
    expect(p.optsLog[0]?.tools).toEqual(tools);
  });
});
