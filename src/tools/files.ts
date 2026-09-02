import type { ToolSpec } from "../provider";
import type { Workspace } from "./workspace";

const READ_CAP = 64_000;
const TRUNC_MARKER = "…[truncated]";

export type BuiltinTool = {
  spec: ToolSpec;
  run(args: unknown, ws: Workspace): Promise<{ ok: boolean; output: string }>;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export const readFileTool: BuiltinTool = {
  spec: {
    name: "read_file",
    description: "Read a file within the workspace, optionally with an offset/limit on lines.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "number" },
        limit: { type: "number" },
      },
      required: ["path"],
    },
  },
  async run(args, ws) {
    try {
      if (!isRecord(args) || typeof args.path !== "string") {
        return { ok: false, output: "read_file: args.path must be a string" };
      }
      if (args.offset !== undefined && typeof args.offset !== "number") {
        return { ok: false, output: "read_file: args.offset must be a number" };
      }
      if (args.limit !== undefined && typeof args.limit !== "number") {
        return { ok: false, output: "read_file: args.limit must be a number" };
      }
      const resolved = ws.contain(args.path);
      let text = await Bun.file(resolved).text();
      if (args.offset !== undefined || args.limit !== undefined) {
        const lines = text.split("\n");
        const start = args.offset ?? 0;
        const end = args.limit !== undefined ? start + args.limit : undefined;
        text = lines.slice(start, end).join("\n");
      }
      if (text.length > READ_CAP) {
        text = text.slice(0, READ_CAP) + TRUNC_MARKER;
      }
      return { ok: true, output: text };
    } catch (e) {
      return { ok: false, output: errMessage(e) };
    }
  },
};

export const writeFileTool: BuiltinTool = {
  spec: {
    name: "write_file",
    description: "Write a file within the workspace. Refuses to overwrite unless {overwrite: true}.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        overwrite: { type: "boolean" },
      },
      required: ["path", "content"],
    },
  },
  async run(args, ws) {
    try {
      if (!isRecord(args) || typeof args.path !== "string") {
        return { ok: false, output: "write_file: args.path must be a string" };
      }
      if (typeof args.content !== "string") {
        return { ok: false, output: "write_file: args.content must be a string" };
      }
      if (args.overwrite !== undefined && typeof args.overwrite !== "boolean") {
        return { ok: false, output: "write_file: args.overwrite must be a boolean" };
      }
      const resolved = ws.contain(args.path);
      const exists = await Bun.file(resolved).exists();
      if (exists && args.overwrite !== true) {
        return { ok: false, output: `write_file: refusing to overwrite existing file: ${resolved}` };
      }
      await Bun.write(resolved, args.content);
      return { ok: true, output: `wrote ${args.content.length} chars to ${resolved}` };
    } catch (e) {
      return { ok: false, output: errMessage(e) };
    }
  },
};

export const editFileTool: BuiltinTool = {
  spec: {
    name: "edit_file",
    description: "Replace an exact-match substring in a file. Fails unless old matches exactly once.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old: { type: "string" },
        new: { type: "string" },
      },
      required: ["path", "old", "new"],
    },
  },
  async run(args, ws) {
    try {
      if (!isRecord(args) || typeof args.path !== "string") {
        return { ok: false, output: "edit_file: args.path must be a string" };
      }
      if (typeof args.old !== "string" || typeof args.new !== "string") {
        return { ok: false, output: "edit_file: args.old and args.new must be strings" };
      }
      const resolved = ws.contain(args.path);
      const text = await Bun.file(resolved).text();
      const count = text.split(args.old).length - 1;
      if (count !== 1) {
        return { ok: false, output: `edit_file: expected exactly 1 match for old, found ${count}` };
      }
      const idx = text.indexOf(args.old);
      const updated = text.slice(0, idx) + args.new + text.slice(idx + args.old.length);
      await Bun.write(resolved, updated);
      return { ok: true, output: `edited ${resolved}` };
    } catch (e) {
      return { ok: false, output: errMessage(e) };
    }
  },
};
