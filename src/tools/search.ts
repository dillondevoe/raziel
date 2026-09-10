import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { BuiltinTool } from "./files";
import type { Workspace } from "./workspace";

const MAX_WALK_FILES = 200;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function walkFiles(root: string, cap: number): Promise<string[]> {
  const out: string[] = [];
  async function visit(dir: string): Promise<void> {
    if (out.length >= cap) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (out.length >= cap) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  await visit(root);
  return out;
}

export const grepTool: BuiltinTool = {
  spec: {
    name: "grep",
    description: "Search for a regex pattern in a file or directory (defaults to the workspace). Directory searches are capped at 200 files with a truncation notice.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
      },
      required: ["pattern"],
    },
  },
  async run(args, ws) {
    try {
      if (!isRecord(args) || typeof args.pattern !== "string") {
        return { ok: false, output: "grep: args.pattern must be a string" };
      }
      if (args.path !== undefined && typeof args.path !== "string") {
        return { ok: false, output: "grep: args.path must be a string" };
      }
      let re: RegExp;
      try {
        re = new RegExp(args.pattern);
      } catch (e) {
        return { ok: false, output: `grep: invalid pattern: ${errMessage(e)}` };
      }

      const path = ws.contain(args.path ?? ".");
      // One extra filename detects truncation without reading past the cap.
      const files = (await stat(path)).isDirectory()
        ? await walkFiles(path, MAX_WALK_FILES + 1)
        : [path];

      const matches: string[] = [];
      for (const file of files.slice(0, MAX_WALK_FILES)) {
        const text = await Bun.file(ws.contain(file)).text();
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i]!)) {
            matches.push(`${relative(ws.root, file)}:${i + 1}:${lines[i]}`);
          }
        }
      }
      if (files.length > MAX_WALK_FILES) {
        matches.push(`[truncated: searched ${MAX_WALK_FILES} files; narrow path]`);
      }
      return { ok: true, output: matches.join("\n") };
    } catch (e) {
      return { ok: false, output: errMessage(e) };
    }
  },
};

export const globTool: BuiltinTool = {
  spec: {
    name: "glob",
    description: "Find files within the workspace matching a glob pattern.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
      },
      required: ["pattern"],
    },
  },
  async run(args, ws) {
    try {
      if (!isRecord(args) || typeof args.pattern !== "string") {
        return { ok: false, output: "glob: args.pattern must be a string" };
      }
      if (isAbsolute(args.pattern) || args.pattern.split(/[\\/]/).includes("..")) {
        return { ok: false, output: `glob: pattern escapes workspace: ${args.pattern}` };
      }
      const glob = new Bun.Glob(args.pattern);
      const results: string[] = [];
      for await (const match of glob.scan({ cwd: ws.root })) {
        // Belt and braces: every match must independently resolve under
        // root (catches a symlink inside root pointing outside it).
        ws.contain(match);
        results.push(match);
      }
      return { ok: true, output: results.join("\n") };
    } catch (e) {
      return { ok: false, output: errMessage(e) };
    }
  },
};
