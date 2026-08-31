import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionEvent } from "./events";

export function razielHome(): string {
  return process.env.RAZIEL_HOME ?? join(homedir(), ".raziel");
}

function sessionsDir(): string {
  const d = join(razielHome(), "sessions");
  mkdirSync(d, { recursive: true });
  return d;
}

export class SessionStore {
  readonly id: string;
  readonly path: string;

  constructor(sessionId?: string) {
    this.id = sessionId ?? new Date().toISOString().replace(/[:.]/g, "-");
    this.path = join(sessionsDir(), `${this.id}.jsonl`);
  }

  append(e: SessionEvent): void {
    appendFileSync(this.path, JSON.stringify(e) + "\n");
  }

  replay(): SessionEvent[] {
    if (!existsSync(this.path)) return [];
    const out: SessionEvent[] = [];
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as SessionEvent); } catch { /* torn line: skip */ }
    }
    return out;
  }

  static list(): string[] {
    return readdirSync(sessionsDir())
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.slice(0, -6))
      .sort()
      .reverse();
  }
}
