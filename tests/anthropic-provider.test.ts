import { test, expect } from "bun:test";
import { AnthropicProvider } from "../src/providers/anthropic";

test("constructs without network and implements Provider", () => {
  const p = new AnthropicProvider({ apiKey: "test-key-not-real" });
  expect(p.name).toBe("anthropic");
  expect(typeof p.stream).toBe("function");
});
