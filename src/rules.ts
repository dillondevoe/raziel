import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { canonicalJson } from "./tools/types";

export type StandingRule = { tool: string; pattern: string };

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

// R12 narrow-keys, fixed semantically (fix round): a pattern made of ONLY
// "*" characters matches everything regardless of how many wildcards it has
// — a strict `pattern === "*"` check misses "**", "***", etc. (each extra
// "*" just compiles to another no-op ".*" in the regex). And this isn't a
// high-risk-tool-only concern: a rule that matches literally every call is
// never "narrow", for ANY tool, so add() refuses it universally rather than
// gating on a static high-risk tool set.
function isAllWildcard(pattern: string): boolean {
  return pattern.replace(/\*/g, "") === "";
}

/**
 * Standing approval rules, persisted as JSON. Loading never throws (R13
 * fail-closed posture extends to config: a corrupt rules file degrades to
 * "no standing rules", not a crash), and add() refuses any all-wildcard
 * pattern — one that matches every call for a tool is never narrow (R12).
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
    if (isAllWildcard(rule.pattern)) {
      throw new Error(
        `rules: refusing an all-wildcard pattern (matches everything, never narrow — R12): ${JSON.stringify(rule)}`,
      );
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

  /** Removes the rule at 1-indexed position `n` (matching the numbered
   * `/approve` listing). Returns false (no-op) if `n` is out of range. */
  removeAt(n: number): boolean {
    const idx = n - 1;
    if (idx < 0 || idx >= this.rules.length) return false;
    this.rules.splice(idx, 1);
    return true;
  }

  list(): StandingRule[] {
    return [...this.rules];
  }
}
