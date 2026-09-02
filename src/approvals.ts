import { sanitizeForTerminal } from "./term";
import { argsHash, canonicalJson } from "./tools/types";
import type { RiskClass } from "./tools/types";
import type { Workspace } from "./tools/workspace";
import type { Rules } from "./rules";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// Byte-exact display (R11): a raw \n or \r inside an arg value must never
// reach the terminal as an actual line break / carriage return, where it
// could visually forge extra card lines. Shown as the literal two
// characters backslash-n / backslash-r instead.
function escapeArgValue(s: string): string {
  return s.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

export type ApprovalDeps = {
  ask(card: string, risk: RiskClass): Promise<"allow" | "deny" | "always">;
};

/** Renders the human-facing approval card for one tool call. The whole card
 * is passed through sanitizeForTerminal as a final safety net (strips ESC
 * sequences etc.); the args rendering is additionally escaped so an
 * embedded \n/\r can't be mistaken for card structure. */
export function buildCard(tool: string, args: unknown, risk: RiskClass, ws: Workspace): string {
  const hash = argsHash(tool, args);
  const encodedArgs = escapeArgValue(canonicalJson(args));

  const lines = [`tool: ${tool}`, `risk: ${risk}`, `args: ${encodedArgs}`];

  if (isRecord(args) && typeof args.path === "string") {
    let resolved: string;
    try {
      resolved = ws.contain(args.path);
    } catch {
      resolved = "ESCAPES WORKSPACE";
    }
    lines.push(`path: ${resolved}`);
  }

  lines.push(`argsHash: ${hash.slice(0, 8)}`);

  return sanitizeForTerminal(lines.join("\n"));
}

/**
 * Gates every tool call through risk + standing rules + (if needed) an
 * interactive prompt. Order (R14): critical always denies without
 * prompting; a standing-rule match auto-allows ONLY low/medium risk
 * (high/critical always prompt, never bypassed by a rule); otherwise the
 * caller is asked, and "always" persists a new standing rule before
 * allowing. The returned argsHash always comes from the shared argsHash()
 * primitive so it binds to exactly what was decided on.
 */
export class ApprovalManager {
  private rules: Rules;
  private deps: ApprovalDeps;
  private rulesPath: string;

  constructor(rules: Rules, deps: ApprovalDeps, rulesPath: string) {
    this.rules = rules;
    this.deps = deps;
    this.rulesPath = rulesPath;
  }

  async decide(
    tool: string,
    args: unknown,
    risk: RiskClass,
    ws: Workspace,
  ): Promise<{ decision: "allow" | "deny"; argsHash: string }> {
    const hash = argsHash(tool, args);

    if (risk === "critical") {
      return { decision: "deny", argsHash: hash };
    }

    if ((risk === "low" || risk === "medium") && this.rules.matches(tool, args)) {
      return { decision: "allow", argsHash: hash };
    }

    const card = buildCard(tool, args, risk, ws);
    const answer = await this.deps.ask(card, risk);

    if (answer === "always") {
      this.rules.add({ tool, pattern: canonicalJson(args) });
      this.rules.save(this.rulesPath);
      return { decision: "allow", argsHash: hash };
    }

    return { decision: answer === "allow" ? "allow" : "deny", argsHash: hash };
  }
}
