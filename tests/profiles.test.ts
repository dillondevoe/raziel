import { test, expect } from "bun:test";
import { getProfile, listProfiles, defaultProfileId } from "../src/profiles";

test("getProfile returns the sonnet profile with expected fields", () => {
  const sonnet = getProfile("sonnet");
  expect(sonnet).toBeDefined();
  expect(sonnet!.id).toBe("sonnet");
  expect(sonnet!.provider).toBe("anthropic");
  expect(sonnet!.model).toBe("claude-sonnet-5");
  expect(sonnet!.contextTokens).toBe(200_000);
  expect(sonnet!.maxToolSurface).toBe(24);
  expect(sonnet!.parser).toBe("native");
  expect(sonnet!.streamingTools).toBe(true);
  expect(sonnet!.sampling).toBeUndefined();
  expect(sonnet!.escalateTo).toBeUndefined();
});

test("getProfile returns the qwen profile with expected fields", () => {
  const qwen = getProfile("qwen");
  expect(qwen).toBeDefined();
  expect(qwen!.id).toBe("qwen");
  expect(qwen!.provider).toBe("ollama");
  expect(qwen!.model).toBe("qwen3.5:9b");
  expect(qwen!.baseUrl).toBe("http://127.0.0.1:11434");
  expect(qwen!.contextTokens).toBe(32_768);
  expect(qwen!.maxToolSurface).toBe(6);
  expect(qwen!.parser).toBe("native");
  expect(qwen!.sampling).toEqual({ temperature: 0.7, topP: 0.8 });
  expect(qwen!.streamingTools).toBe(false);
  expect(qwen!.escalateTo).toBe("sonnet");
});

test("getProfile returns undefined for an unknown id", () => {
  expect(getProfile("does-not-exist")).toBeUndefined();
});

test("listProfiles returns every registry entry", () => {
  const all = listProfiles();
  expect(all.map((p) => p.id).sort()).toEqual(["qwen", "sonnet"]);
});

test("defaultProfileId is sonnet", () => {
  expect(defaultProfileId()).toBe("sonnet");
});

test("registry entries are frozen — a caller can't mutate the live objects (M9)", () => {
  // ES modules are always strict mode, so a mutation attempt on a frozen
  // object throws TypeError rather than silently no-op-ing.
  const sonnet = getProfile("sonnet")!;
  expect(() => { (sonnet as any).model = "tampered"; }).toThrow();
  expect(getProfile("sonnet")!.model).toBe("claude-sonnet-5");

  const qwen = getProfile("qwen")!;
  expect(() => { (qwen.sampling as any).temperature = 999; }).toThrow();
  expect(getProfile("qwen")!.sampling).toEqual({ temperature: 0.7, topP: 0.8 });

  expect(() => { (listProfiles() as any).push({}); }).toThrow();
});
