import type { BuiltinTool } from "./files";
import type { Workspace } from "./workspace";

const OUTPUT_CAP = 64_000;
const TIMEOUT_MS = 30_000;
const TRUNC_MARKER = "…[truncated]";

const DROP_EXACT = new Set(["ANTHROPIC_API_KEY", "RAZIEL_COMPAT_KEY"]);
const DROP_SUFFIX = /(_KEY|_TOKEN|_SECRET|_PASSWORD)$/i;
const DROP_PREFIX = /^(AWS|GH|GITHUB|OPENAI|NPM)_/i;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function shouldDrop(name: string): boolean {
  return DROP_EXACT.has(name) || DROP_SUFFIX.test(name) || DROP_PREFIX.test(name);
}

export function scrubEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (shouldDrop(name)) continue;
    out[name] = value;
  }
  return out;
}

function cap(text: string): string {
  return text.length > OUTPUT_CAP ? text.slice(0, OUTPUT_CAP) + TRUNC_MARKER : text;
}

export const runCommandTool: BuiltinTool = {
  spec: {
    name: "run_command",
    description: "Run a command given as an argv array (never a shell string), with a scrubbed environment.",
    inputSchema: {
      type: "object",
      properties: {
        argv: { type: "array", items: { type: "string" } },
        cwd: { type: "string" },
      },
      required: ["argv"],
    },
  },
  async run(args, ws: Workspace) {
    try {
      if (!isRecord(args) || !Array.isArray(args.argv)) {
        return { ok: false, output: "run_command: args.argv must be an array of strings" };
      }
      if (args.argv.length === 0 || !args.argv.every((a) => typeof a === "string")) {
        return { ok: false, output: "run_command: args.argv must be a non-empty array of strings" };
      }
      if (args.cwd !== undefined && typeof args.cwd !== "string") {
        return { ok: false, output: "run_command: args.cwd must be a string" };
      }
      let cwd: string;
      try {
        cwd = ws.contain(args.cwd ?? ".");
      } catch (e) {
        return { ok: false, output: `run_command: ${errMessage(e)}` };
      }

      const env = scrubEnv(process.env);

      let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
      try {
        proc = Bun.spawn(args.argv as string[], {
          cwd,
          env,
          stdout: "pipe",
          stderr: "pipe",
        });
      } catch (e) {
        return { ok: false, output: `run_command: ${errMessage(e)}` };
      }

      const timer = setTimeout(() => {
        try {
          proc.kill();
        } catch {
          // already dead
        }
      }, TIMEOUT_MS);

      try {
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        const body = [stdout, stderr].filter((s) => s.length > 0).join("\n");
        return { ok: exitCode === 0, output: cap(`exit ${exitCode}\n${body}`) };
      } catch (e) {
        return { ok: false, output: `run_command: ${errMessage(e)}` };
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      return { ok: false, output: errMessage(e) };
    }
  },
};
