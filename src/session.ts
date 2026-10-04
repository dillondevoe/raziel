import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { isValidEvent, type SessionEvent } from "./events";

export function razielHome(): string {
  return process.env.RAZIEL_HOME ?? join(homedir(), ".raziel");
}

function sessionsDir(): string {
  const d = join(razielHome(), "sessions");
  // Session logs are plaintext and may hold secrets: owner-only. mkdir's mode is
  // masked by umask and ignored for existing dirs, so tighten explicitly.
  mkdirSync(d, { recursive: true, mode: 0o700 });
  try { chmodSync(d, 0o700); } catch { /* not owner / unsupported fs: best effort */ }
  return d;
}

const SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Validates a session id at the store boundary. Throws a clear error on any
 * shape that could escape sessionsDir(): disallowed characters, `..`
 * segments, or (belt-and-braces) a resolved path outside sessionsDir().
 */
function validateSessionId(id: string): string {
  if (!SESSION_ID_RE.test(id) || id.includes("..")) {
    throw new Error(`invalid session id ${JSON.stringify(id)}`);
  }
  const dir = sessionsDir();
  const candidate = resolve(join(dir, `${id}.jsonl`));
  if (!candidate.startsWith(resolve(dir) + sep)) {
    throw new Error(`invalid session id ${JSON.stringify(id)}`);
  }
  return id;
}

export class SessionStore {
  readonly id: string;
  readonly path: string;

  constructor(sessionId?: string) {
    this.id = validateSessionId(sessionId ?? new Date().toISOString().replace(/[:.]/g, "-"));
    this.path = join(sessionsDir(), `${this.id}.jsonl`);
  }

  private tightened = false;

  append(e: SessionEvent): void {
    appendFileSync(this.path, JSON.stringify(e) + "\n", { mode: 0o600 });
    if (!this.tightened) {
      // `mode` applies only when the file is created; fix logs written before this.
      try { chmodSync(this.path, 0o600); } catch { /* best effort */ }
      this.tightened = true;
    }
  }

  replay(): SessionEvent[] {
    if (!existsSync(this.path)) return [];
    const out: SessionEvent[] = [];
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { continue; /* torn line: skip */ }
      if (isValidEvent(parsed)) out.push(parsed);
      // else: forged/invalid-but-parseable line — skip, same crash-tolerance semantics
    }
    return out;
  }

  static list(): string[] {
    const dir = sessionsDir();
    return readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const id = f.slice(0, -6);
        return { id, mtimeMs: statSync(join(dir, f)).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs || b.id.localeCompare(a.id))
      .map((e) => e.id);
  }
}
