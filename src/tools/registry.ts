import type { ToolSpec } from "../provider";
import type { BuiltinTool } from "./files";
import { readFileTool, writeFileTool, editFileTool } from "./files";
import { grepTool, globTool } from "./search";
import { runCommandTool } from "./exec";
import { fetchTool } from "./fetch";

/** The full builtin tool surface, in a fixed insertion order (profile
 * maxToolSurface slicing, wired later, takes the first N in this order). */
export function builtinTools(): Map<string, BuiltinTool> {
  const tools = new Map<string, BuiltinTool>();
  tools.set("read_file", readFileTool);
  tools.set("write_file", writeFileTool);
  tools.set("edit_file", editFileTool);
  tools.set("grep", grepTool);
  tools.set("glob", globTool);
  tools.set("run_command", runCommandTool);
  tools.set("fetch", fetchTool);
  return tools;
}

/** Projects a tool registry to the ToolSpec[] shape a Provider.stream() call
 * advertises, preserving the map's iteration (insertion) order. */
export function toolSpecs(tools: Map<string, BuiltinTool>): ToolSpec[] {
  return [...tools.values()].map((t) => t.spec);
}
