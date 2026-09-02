import { test, expect } from "bun:test";
import { FakeProvider } from "../src/providers/fake";

test("fake provider yields scripted deltas then done, and records calls", async () => {
  const p = new FakeProvider([["Hel", "lo"]]);
  const chunks: string[] = [];
  for await (const c of p.stream({ model: "m", messages: [{ role: "user", content: "hi" }] })) {
    if (c.type === "delta") chunks.push(c.text);
    else if (c.type === "done") expect(c.stopReason).toBe("end");
  }
  expect(chunks.join("")).toBe("Hello");
  expect(p.calls[0]?.[0]?.content).toBe("hi");
});

test("fake provider stops on abort", async () => {
  const p = new FakeProvider([["a", "b", "c"]]);
  const ctl = new AbortController();
  const got: string[] = [];
  for await (const c of p.stream({ model: "m", messages: [], signal: ctl.signal })) {
    if (c.type === "delta") { got.push(c.text); ctl.abort(); }
  }
  expect(got).toEqual(["a"]);
});
