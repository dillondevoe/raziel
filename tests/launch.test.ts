import { test, expect } from "bun:test";
import { parseLaunchFlags } from "../src/launch";

// The headless launch surface: --grant / --allow-run / --max-rounds, with env
// fallbacks so a launcher script can set policy without quoting argv. Flags
// win over env. Malformed values throw at parse time, before any provider is
// built -- a typo in a grant must not become a run that denies everything.

test("no flags, no env: nothing granted, default rounds", () => {
  const f = parseLaunchFlags([], {});
  expect(f.grant).toBeUndefined();
  expect(f.maxRounds).toBeUndefined();
});

test("--grant and repeatable --allow-run build one grant", () => {
  const f = parseLaunchFlags(["--grant", "write", "--allow-run", "bun test", "--allow-run", "git commit"], {});
  expect(f.grant!.describe()).toBe('grant: read,write; run: "bun test", "git commit"');
});

test("env fallbacks: RAZIEL_GRANT, RAZIEL_ALLOW_RUN (semicolon-separated), RAZIEL_MAX_ROUNDS", () => {
  const f = parseLaunchFlags([], { RAZIEL_GRANT: "read", RAZIEL_ALLOW_RUN: "bun test; git status", RAZIEL_MAX_ROUNDS: "40" });
  expect(f.grant!.describe()).toBe('grant: read; run: "bun test", "git status"');
  expect(f.maxRounds).toBe(40);
});

test("flags win over env", () => {
  const f = parseLaunchFlags(["--grant", "write", "--max-rounds", "12"], { RAZIEL_GRANT: "read", RAZIEL_MAX_ROUNDS: "40" });
  expect([...f.grant!.classes].sort()).toEqual(["read", "write"]);
  expect(f.maxRounds).toBe(12);
});

test("--allow-run without any --grant still yields a grant (run-only), which also makes the run headless", () => {
  const f = parseLaunchFlags(["--allow-run", "bun test"], {});
  expect(f.grant).toBeDefined();
  expect(f.grant!.classes.size).toBe(0);
  expect(f.grant!.covers("run_command", { argv: ["bun", "test"] }, "high")).toBe(true);
  expect(f.grant!.covers("read_file", { path: "a" }, "low")).toBe(false);
});

test("bad values throw: unknown class, non-integer or non-positive rounds, dangling flag", () => {
  expect(() => parseLaunchFlags(["--grant", "shell"], {})).toThrow(/unknown grant class/);
  expect(() => parseLaunchFlags(["--max-rounds", "zero"], {})).toThrow(/--max-rounds/);
  expect(() => parseLaunchFlags(["--max-rounds", "0"], {})).toThrow(/--max-rounds/);
  expect(() => parseLaunchFlags([], { RAZIEL_MAX_ROUNDS: "-3" })).toThrow(/RAZIEL_MAX_ROUNDS/);
  expect(() => parseLaunchFlags(["--grant"], {})).toThrow(/--grant/);
  expect(() => parseLaunchFlags(["--allow-run"], {})).toThrow(/--allow-run/);
});
