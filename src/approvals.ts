import { sanitizeForTerminal } from "./term";
import { argsHash, canonicalJson } from "./tools/types";
import type { RiskClass } from "./tools/types";
import type { Workspace } from "./tools/workspace";
import type { Rules } from "./rules";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// Byte-exact display (R11) AND the actual card-injection guard: a raw \n or
// \r inside ANY value interpolated into the card must never reach the
// terminal as a real line break, or it can forge extra "field: value" lines
// indistinguishable from genuine ones (e.g. a `path` arg containing
// "\nrisk: low\nargsHash: ..." rendered next to the real risk/hash fields).
// Shown as the literal two characters backslash-n / backslash-r instead.
//
// Note: this is a no-op on canonicalJson(args) itself — JSON.stringify
// already backslash-escapes \n/\r inside string leaves — so the real
// enforcement point is values assembled OUTSIDE the JSON encoding, chiefly
// the resolved `path:` line built from ws.contain()'s return value (which
// happily "resolves" a not-yet-existing path containing raw newlines).
// Applied uniformly to every interpolated line so no future field is
// accidentally exempt.
function escapeForCard(s: string): string {
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
  const encodedArgs = escapeForCard(canonicalJson(args));

  const lines = [`tool: ${escapeForCard(tool)}`, `risk: ${risk}`, `args: ${encodedArgs}`];

  if (isRecord(args) && typeof args.path === "string") {
    let resolved: string;
    try {
      resolved = ws.contain(args.path);
    } catch {
      resolved = "ESCAPES WORKSPACE";
    }
    lines.push(`path: ${escapeForCard(resolved)}`);
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
