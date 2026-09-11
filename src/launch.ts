import { Grant, parseGrant } from "./grant";

export type LaunchFlags = {
  grant?: Grant;
  maxRounds?: number;
};

function valuesOf(argv: readonly string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== name) continue;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${name} needs a value`);
    out.push(v);
    i++;
  }
  return out;
}

function parseRounds(raw: string, label: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${label} must be a positive integer, got ${JSON.stringify(raw)}`);
  return n;
}

/** The headless launch surface. Flags win over env; env exists so a launcher
 * script can set policy without quoting argv:
 *   --grant read|write|fetch[,…]   RAZIEL_GRANT
 *   --allow-run "<argv prefix>"    RAZIEL_ALLOW_RUN  (";"-separated, repeatable flag)
 *   --max-rounds N                 RAZIEL_MAX_ROUNDS
 * Any grant or allow-run present makes the run UNATTENDED (see src/grant.ts):
 * an uncovered call is denied, never asked. Throws on malformed input so a
 * typo is a failed launch, not a silent deny-everything run. */
export function parseLaunchFlags(argv: readonly string[], env: Record<string, string | undefined>): LaunchFlags {
  const grantFlag = valuesOf(argv, "--grant");
  if (grantFlag.length > 1) throw new Error("--grant given more than once; use a comma list");
  const grantSpec = grantFlag[0] ?? env.RAZIEL_GRANT;

  const allowFlags = valuesOf(argv, "--allow-run");
  const allowRun = allowFlags.length > 0
    ? allowFlags
    : (env.RAZIEL_ALLOW_RUN ?? "").split(";").map((s) => s.trim()).filter((s) => s.length > 0);

  let grant: Grant | undefined;
  if (grantSpec !== undefined && grantSpec.trim().length > 0) grant = parseGrant(grantSpec, allowRun);
  else if (allowRun.length > 0) grant = new Grant(new Set(), parseGrant("read", allowRun).runPrefixes);

  const roundsFlag = valuesOf(argv, "--max-rounds");
  if (roundsFlag.length > 1) throw new Error("--max-rounds given more than once");
  let maxRounds: number | undefined;
  if (roundsFlag[0] !== undefined) maxRounds = parseRounds(roundsFlag[0], "--max-rounds");
  else if (env.RAZIEL_MAX_ROUNDS !== undefined && env.RAZIEL_MAX_ROUNDS !== "") maxRounds = parseRounds(env.RAZIEL_MAX_ROUNDS, "RAZIEL_MAX_ROUNDS");

  return { grant, maxRounds };
}
