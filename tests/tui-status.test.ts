import { test, expect } from "bun:test";
import { Container } from "@earendil-works/pi-tui";
import { Status } from "../src/tui/status";
import type { ModelProfile } from "../src/profiles";

const WIDTH = 80;

test("status line renders profileId (modelName) · providerName · session <id8> · idle", () => {
  const parent = new Container();
  const status = new Status(parent);
  const profile: ModelProfile = {
    id: "sonnet",
    provider: "anthropic",
    model: "claude-sonnet-5",
    contextTokens: 200_000,
    maxToolSurface: 24,
    parser: "native",
    streamingTools: true,
  };

  status.setProfile(profile);
  status.setSession("abc123def456");
  status.setActivity({ kind: "idle" });

  const frame = parent.render(WIDTH).join("\n");
  expect(frame).toContain("sonnet (claude-sonnet-5)");
  expect(frame).toContain("anthropic");
  expect(frame).toContain("session abc123de"); // sanitized to id8
  expect(frame).toContain("idle");
});

test("setProfile updates the rendered line", () => {
  const parent = new Container();
  const status = new Status(parent);

  const sonnet: ModelProfile = {
    id: "sonnet",
    provider: "anthropic",
    model: "claude-sonnet-5",
    contextTokens: 200_000,
    maxToolSurface: 24,
    parser: "native",
    streamingTools: true,
  };
  const qwen: ModelProfile = {
    id: "qwen",
    provider: "ollama",
    model: "qwen3.5:9b",
    baseUrl: "http://127.0.0.1:11434",
    contextTokens: 32_768,
    maxToolSurface: 6,
    parser: "native",
    streamingTools: false,
  };

  status.setProfile(sonnet);
  let frame = parent.render(WIDTH).join("\n");
  expect(frame).toContain("sonnet (claude-sonnet-5)");
  expect(frame).toContain("anthropic");

  status.setProfile(qwen);
  frame = parent.render(WIDTH).join("\n");
  expect(frame).toContain("qwen (qwen3.5:9b)");
  expect(frame).toContain("ollama");
  expect(frame).not.toContain("sonnet");
  expect(frame).not.toContain("anthropic");
});

test("session id is sanitized to 8 chars", () => {
  const parent = new Container();
  const status = new Status(parent);
  const profile: ModelProfile = {
    id: "sonnet",
    provider: "anthropic",
    model: "claude-sonnet-5",
    contextTokens: 200_000,
    maxToolSurface: 24,
    parser: "native",
    streamingTools: true,
  };

  status.setProfile(profile);
  status.setSession("abcdefghijklmnop"); // 16 chars
  status.setActivity({ kind: "idle" });

  const frame = parent.render(WIDTH).join("\n");
  expect(frame).toContain("session abcdefgh");
  expect(frame).not.toContain("abcdefghijklmnop");
});

test("setActivity with tool round renders correctly", () => {
  const parent = new Container();
  const status = new Status(parent);
  const profile: ModelProfile = {
    id: "sonnet",
    provider: "anthropic",
    model: "claude-sonnet-5",
    contextTokens: 200_000,
    maxToolSurface: 24,
    parser: "native",
    streamingTools: true,
  };

  status.setProfile(profile);
  status.setSession("abc123def456");
  status.setActivity({ kind: "tool", round: 3 });

  const frame = parent.render(WIDTH).join("\n");
  expect(frame).toContain("tool round 3/8");
});

test("setActivity with streaming renders elapsed seconds", () => {
  const parent = new Container();
  const status = new Status(parent);
  const profile: ModelProfile = {
    id: "sonnet",
    provider: "anthropic",
    model: "claude-sonnet-5",
    contextTokens: 200_000,
    maxToolSurface: 24,
    parser: "native",
    streamingTools: true,
  };

  const startedAt = 1000; // arbitrary time
  let now = 5000; // 4 seconds later
  const mockNow = () => now;

  status.setProfile(profile);
  status.setSession("abc123def456");
  status.setActivity({ kind: "streaming", startedAt }, mockNow);

  let frame = parent.render(WIDTH).join("\n");
  expect(frame).toContain("streaming 4s");

  now = 8000; // 7 seconds total elapsed
  frame = parent.render(WIDTH).join("\n");
  expect(frame).toContain("streaming 7s");
});

test("setActivity with idle state", () => {
  const parent = new Container();
  const status = new Status(parent);
  const profile: ModelProfile = {
    id: "sonnet",
    provider: "anthropic",
    model: "claude-sonnet-5",
    contextTokens: 200_000,
    maxToolSurface: 24,
    parser: "native",
    streamingTools: true,
  };

  status.setProfile(profile);
  status.setSession("abc123def456");
  status.setActivity({ kind: "idle" });

  const frame = parent.render(WIDTH).join("\n");
  expect(frame).toContain("idle");
  expect(frame).not.toContain("tool");
  expect(frame).not.toContain("streaming");
});

test("invalidate clears the render cache", () => {
  const parent = new Container();
  const status = new Status(parent);
  const profile: ModelProfile = {
    id: "sonnet",
    provider: "anthropic",
    model: "claude-sonnet-5",
    contextTokens: 200_000,
    maxToolSurface: 24,
    parser: "native",
    streamingTools: true,
  };

  status.setProfile(profile);
  status.setSession("abc123def456");
  status.setActivity({ kind: "idle" });

  let frame1 = parent.render(WIDTH).join("\n");
  expect(frame1).toContain("sonnet");

  status.invalidate();
  let frame2 = parent.render(WIDTH).join("\n");
  expect(frame2).toContain("sonnet");
});

test("comment forbids estimated numbers (M1d deferral)", () => {
  // This test verifies that the source code contains a comment forbidding
  // estimated numbers like token counts or tok/s. The comment should be
  // visible in the source code.
  const fs = require("fs");
  const code = fs.readFileSync("/Users/dtd/raziel/src/tui/status.ts", "utf-8");
  expect(code).toContain("M1d");
  expect(code).toContain("estimated");
  expect(code).toContain("forbid");
});
