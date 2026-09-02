import { classifyUrl } from "./tools/fetch";
import type { RiskClass } from "./tools/types";
import type { Workspace } from "./tools/workspace";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function containedRisk(ws: Workspace, path: string, ifContained: RiskClass): RiskClass {
  try {
    ws.contain(path);
    return ifContained;
  } catch {
    return "critical";
  }
}

/**
 * Computes the RiskClass for a tool call before it reaches approval. This is
 * the R13 fail-closed floor: an unrecognized tool name, non-object args, a
 * missing required path/url, or a path that escapes the workspace
 * (ws.contain throws) all come back "critical" — never silently downgraded.
 *
 * fetch's risk doubles as the SSRF gate (R10): fetchTool itself does not
 * self-gate on private/invalid targets — this function does, via
 * classifyUrl. run_command is always "high" in M1b regardless of argv.
 */
export function riskClassFor(tool: string, args: unknown, ws: Workspace): RiskClass {
  if (!isRecord(args)) return "critical";

  switch (tool) {
    case "read_file": {
      return typeof args.path === "string" ? containedRisk(ws, args.path, "low") : "critical";
    }
    case "glob": {
      return typeof args.pattern === "string" ? containedRisk(ws, args.pattern, "low") : "critical";
    }
    case "grep": {
      const path = typeof args.path === "string" ? args.path : ".";
      return containedRisk(ws, path, "low");
    }
    case "write_file":
    case "edit_file": {
      return typeof args.path === "string" ? containedRisk(ws, args.path, "medium") : "critical";
    }
    case "run_command":
      return "high";
    case "fetch": {
      if (typeof args.url !== "string") return "critical";
      return classifyUrl(args.url) === "public" ? "medium" : "high";
    }
    default:
      return "critical";
  }
}
