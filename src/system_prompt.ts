import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ModelProfile } from "./profiles";

/** Expand a leading `~` (and only a leading `~`) against the real home dir.
 * Profile paths are authored by hand in the registry, so `~/...` is the
 * natural spelling and the only one we need to support. */
export function realHome(): string {
  // $HOME first: node's homedir() reads the OS user database directly on
  // macOS and ignores the environment, so a caller (a test, a sandbox, a
  // `sudo -H`) that sets HOME would otherwise be silently overruled.
  return process.env.HOME ?? homedir();
}

export function expandHome(p: string, home: string = realHome()): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

/** Read a profile's `systemFile` into the system prompt the Engine carries.
 *
 * Returns `undefined` for a profile with no `systemFile` — that is the
 * pre-existing behaviour of every call site and stays exactly as it was.
 *
 * A profile that DECLARES a systemFile and cannot read it is a different
 * thing: the persona the profile promised is missing, and running on
 * silently is how "the seam exists but has never carried a byte" happened
 * in the first place. So it warns on stderr, loudly and by path, and
 * returns undefined — a broken persona file must not take down a `/model`
 * swap or a resume, but it must never be invisible either. */
export function loadSystemPrompt(
  profile: ModelProfile,
  deps?: {
    readFile?: (path: string) => string;
    home?: string;
    warn?: (msg: string) => void;
  },
): string | undefined {
  if (!profile.systemFile) return undefined;
  const read = deps?.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const warn = deps?.warn ?? ((msg: string) => { process.stderr.write(msg); });
  const path = expandHome(profile.systemFile, deps?.home ?? realHome());
  try {
    const text = read(path);
    if (text.trim() === "") {
      warn(`raziel: profile ${profile.id} systemFile is empty: ${path} (running with no system prompt)\n`);
      return undefined;
    }
    return text;
  } catch (err) {
    warn(
      `raziel: profile ${profile.id} could not read systemFile ${path}: ` +
      `${err instanceof Error ? err.message : String(err)} (running with no system prompt)\n`,
    );
    return undefined;
  }
}

/** True when the path is absolute or `~`-anchored. Not enforced anywhere —
 * exported so a future registry lint can assert profiles don't carry paths
 * that resolve against whatever cwd the user happened to launch from. */
export function isAnchoredPath(p: string): boolean {
  return isAbsolute(p) || p === "~" || p.startsWith("~/");
}
