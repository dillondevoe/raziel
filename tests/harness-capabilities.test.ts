import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Engine } from "../src/engine";
import { SessionStore } from "../src/session";
import { Workspace } from "../src/tools/workspace";
import { readFileTool } from "../src/tools/files";
import { grepTool, globTool } from "../src/tools/search";
import { builtinTools } from "../src/tools/registry";
import { scrubEnv } from "../src/tools/exec";
import { ApprovalManager } from "../src/approvals";
import { Rules } from "../src/rules";
import { renderBook } from "../src/book";
import type { Provider } from "../src/provider";

const checkout = resolve(import.meta.dir, "..");

test("builtin repository access reads and searches this checkout", async () => {
  const ws = new Workspace(checkout);
  const read = await readFileTool.run({ path: "src/provider.ts" }, ws);
  expect(read.ok).toBe(true);
  expect(read.output).toContain("export interface Provider");
  const search = await grepTool.run({ path: "src/providers", pattern: "class AnthropicProvider" }, ws);
  expect(search.ok).toBe(true);
  expect(search.output).toMatch(/src\/providers\/anthropic.ts:\d+:export class AnthropicProvider/);
  const glob = await globTool.run({ pattern: "src/providers/*.ts" }, ws);
  expect(glob.ok).toBe(true);
  expect(glob.output).toContain("src/providers/anthropic.ts");
});

for (const pass of [true, false]) {
  test(`approved run_command executes bun test and collects exit ${pass ? 0 : 1}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "raziel-run-tests-"));
    const prev = process.env.RAZIEL_HOME;
    process.env.RAZIEL_HOME = root;
    try {
      writeFileSync(join(root, "fixture.test.ts"), `import { test, expect } from "bun:test";
        test("child test", () => {
          expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
          expect(process.env.RAZIEL_COMPAT_KEY).toBeUndefined();
          expect(1).toBe(${pass ? 1 : 2});
        });`);
      let round = 0;
      const provider: Provider = {
        name: "scripted",
        async *stream() {
          if (round++ === 0) yield { type: "tool_call", id: "test-run", name: "run_command", args: { argv: [process.execPath, "test", "fixture.test.ts"] } };
          else yield { type: "delta", text: "test result collected" };
          yield { type: "done", stopReason: "end" };
        },
      };
      const store = new SessionStore("test-job");
      const rulesPath = join(root, "rules.json");
      const risks: string[] = [];
      const approvals = new ApprovalManager(Rules.load(rulesPath), {
        ask: async (_card, risk) => { risks.push(risk); return "allow"; },
      }, rulesPath);
      const engine = new Engine({ provider, store, model: "test", tools: { registry: builtinTools(), approvals, ws: new Workspace(root) } });
      for await (const _ of engine.send("run tests")) { /* drain */ }
      const replay = new SessionStore("test-job").replay();
      const result = replay.find((e) => e.type === "tool_result");
      expect(risks).toEqual(["high"]);
      expect(result).toMatchObject({ tool: "run_command", ok: pass, taint: "tool_output" });
      expect(result!.output).toContain(`exit ${pass ? 0 : 1}`);
      expect(result!.output).toContain(pass ? "1 pass" : "1 fail");
      expect(renderBook(replay)).toContain(`exit ${pass ? 0 : 1}`);
    } finally {
      if (prev === undefined) delete process.env.RAZIEL_HOME;
      else process.env.RAZIEL_HOME = prev;
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("plain CLI (fake model) starts and its result is collected by book (fake model)", async () => {
  const root = mkdtempSync(join(tmpdir(), "raziel-cli-probe-"));
  try {
    const env = { ...scrubEnv(process.env), RAZIEL_HOME: root, RAZIEL_FAKE: "1", RAZIEL_PLAIN: "1" };
    const proc = Bun.spawn([process.execPath, "run", "src/cli.ts", "--profile", "astra", "--session", "cli-probe"], {
      cwd: checkout, env, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    proc.stdin.write("hello\n/quit\n");
    proc.stdin.end();
    const [stdout, stderr, rc] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(rc).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("(fake reply)");
    const book = Bun.spawn([process.execPath, "run", "src/cli.ts", "book", "cli-probe"], {
      cwd: checkout, env, stdout: "pipe", stderr: "pipe",
    });
    const [transcript, bookError, bookRc] = await Promise.all([new Response(book.stdout).text(), new Response(book.stderr).text(), book.exited]);
    expect(bookRc).toBe(0);
    expect(bookError).toBe("");
    expect(transcript).toContain("hello");
    expect(transcript).toContain("(fake reply)");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
