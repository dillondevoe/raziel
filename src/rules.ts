import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { canonicalJson } from "./tools/types";

export type StandingRule = { tool: string; pattern: string };

// Tools whose risk is ALWAYS "high" (or worse) in M1b, regardless of args.
// A tool-wide ("*") standing rule on one of these can never legitimately
// auto-allow anything (ApprovalManager only honors rule matches on
// low/medium), so add() refuses to persist one at all — R12 narrow keys,
// defense against a rule file that quietly grows a blanket high-risk grant.
const ALWAYS_HIGH_RISK_TOOLS = new Set(["run_command"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isStandingRule(v: unknown): v is StandingRule {
  return isRecord(v) && typeof v.tool === "string" && typeof v.pattern === "string";
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const GLOB_SPECIAL = /[.+?^${}()|[\]\\]/;

/** Simple glob → RegExp: `*` becomes `.*`, every other regex-special
 * character is escaped literally. Anchored to a full-string match. */
function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (const ch of pattern) {
    out += ch === "*" ? ".*" : GLOB_SPECIAL.test(ch) ? `\\${ch}` : ch;
  }
  return new RegExp(`^${out}$`);
}

/**
 * Standing approval rules, persisted as JSON. Loading never throws (R13
 * fail-closed posture extends to config: a corrupt rules file degrades to
 * "no standing rules", not a crash), and add() refuses to widen a
 * high-risk tool's grant to "*" (R12).
 */
export class Rules {
  private rules: StandingRule[];
  readonly loadWarning: string | undefined;

  private constructor(rules: StandingRule[], loadWarning?: string) {
    this.rules = rules;
    this.loadWarning = loadWarning;
  }

  static load(path: string): Rules {
    if (!existsSync(path)) return new Rules([]);

    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (e) {
      return new Rules([], `rules: failed to read ${path}: ${errMessage(e)}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return new Rules([], `rules: invalid JSON in ${path}: ${errMessage(e)}`);
    }

    if (!Array.isArray(parsed) || !parsed.every(isStandingRule)) {
      return new Rules([], `rules: invalid schema in ${path}`);
    }

    return new Rules(parsed);
  }

  matches(tool: string, args: unknown): boolean {
    const encoded = canonicalJson(args);
    return this.rules.some((r) => r.tool === tool && globToRegExp(r.pattern).test(encoded));
  }

  add(rule: StandingRule): void {
    if (rule.pattern === "*" && ALWAYS_HIGH_RISK_TOOLS.has(rule.tool)) {
      throw new Error(`rules: refusing tool-wide "*" pattern for high-risk tool: ${rule.tool}`);
    }
    this.rules.push(rule);
  }

  save(path: string): void {
    const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(this.rules, null, 2));
    renameSync(tmp, path);
  }

  count(): number {
    return this.rules.length;
  }

  list(): StandingRule[] {
    return [...this.rules];
  }
}
