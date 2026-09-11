import type { RiskClass } from "./tools/types";

// A GRANT is a per-launch authorization for an unattended run. It is not a
// standing rule (rules.json outlives the process and auto-allows low/medium
// forever); a grant lives exactly as long as the invocation that passed it,
// the way `saga-agent.sh --write --run` widens one run and no other.
//
// It names tool CLASSES, not risks: `read` = read_file/glob/grep, `write` =
// read + write_file/edit_file, `fetch` = fetch to PUBLIC urls only. A risk
// ceiling still applies inside each class -- `critical` (an argument that
// escapes the workspace, a malformed call) is never granted by anything --
// and `high` is reachable only through run_command, only by an explicit argv
// PREFIX matched word for word from argv[0]. `git commit` covers
// `git commit -m x`; it does not cover `git push`, `gitk`, or `git`.
// run_command already refuses shell strings (argv arrays only, scrubbed env,
// contained cwd), which is what makes a prefix a meaningful bound.
//
// The presence of ANY grant means "no human is at this keyboard": whatever it
// does not cover is denied at once with a reason, never asked. That is the
// whole point -- a headless run that blocks on stdin is a hung run, and one
// that auto-answers "y" is not headless, it is unattended-with-a-rubber-stamp.

export type GrantClass = "read" | "write" | "fetch";

const CLASS_TOOLS: Record<GrantClass, ReadonlySet<string>> = {
  read: new Set(["read_file", "glob", "grep"]),
  write: new Set(["write_file", "edit_file"]),
  fetch: new Set(["fetch"]),
};

// The risk a class may reach. read tools are `low` when contained; write
// tools `medium`; fetch is `medium` for a public url and `high` for anything
// else (private/loopback), which a grant deliberately cannot reach.
const CLASS_CEILING: Record<GrantClass, ReadonlySet<RiskClass>> = {
  read: new Set<RiskClass>(["low"]),
  write: new Set<RiskClass>(["low", "medium"]),
  fetch: new Set<RiskClass>(["medium"]),
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export class Grant {
  constructor(
    readonly classes: ReadonlySet<GrantClass>,
    readonly runPrefixes: readonly (readonly string[])[],
  ) {}

  covers(tool: string, args: unknown, risk: RiskClass): boolean {
    if (risk === "critical") return false;
    if (tool === "run_command") {
      if (risk !== "high") return false; // run_command is high by construction; anything else is a classifier drift
      if (!isRecord(args) || !Array.isArray(args.argv) || !args.argv.every((a) => typeof a === "string")) return false;
      const argv = args.argv as string[];
      return this.runPrefixes.some((p) => p.length <= argv.length && p.every((w, i) => argv[i] === w));
    }
    for (const c of this.classes) {
      if (CLASS_TOOLS[c].has(tool) && CLASS_CEILING[c].has(risk)) return true;
    }
    return false;
  }

  describe(): string {
    const order: GrantClass[] = ["read", "write", "fetch"];
    const classes = order.filter((c) => this.classes.has(c)).join(",");
    const run = this.runPrefixes.length > 0 ? this.runPrefixes.map((p) => `"${p.join(" ")}"`).join(", ") : "(none)";
    return `grant: ${classes}; run: ${run}`;
  }
}

/** `spec` is a comma list of classes ("write,fetch"); `allowRun` is one argv
 * prefix per entry, split on whitespace. Throws on anything it does not
 * understand -- a grant that silently ignored a typo would be a grant that
 * silently denied everything the operator meant to allow. */
export function parseGrant(spec: string, allowRun: readonly string[]): Grant {
  const names = spec.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (names.length === 0) throw new Error("empty grant: name at least one of read, write, fetch");
  const classes = new Set<GrantClass>();
  for (const n of names) {
    if (n !== "read" && n !== "write" && n !== "fetch") throw new Error(`unknown grant class: ${JSON.stringify(n)} (expected read, write, fetch)`);
    classes.add(n);
    if (n === "write") classes.add("read");
  }
  const prefixes = allowRun.map((s) => {
    const words = s.trim().split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) throw new Error("empty allow-run prefix would match every command; refuse");
    return words;
  });
  return new Grant(classes, prefixes);
}
