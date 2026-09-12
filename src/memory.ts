import { mkdirSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { razielHome } from "./session";

export function memoryDir(): string {
  const d = join(razielHome(), "memory");
  mkdirSync(d, { recursive: true });
  return d;
}

const SCAR_ID_RE = /^[A-Za-z0-9._-]+$/;

/** Same shape as session.ts's validateSessionId — a scar id becomes a
 * filename under memoryDir(), so it gets the same workspace-confinement
 * treatment (M1b's line, §2 of the milestone doc) even though callers here
 * only ever pass generated ids, never user text. */
function validateScarId(id: string): string {
  if (!SCAR_ID_RE.test(id) || id.includes("..")) {
    throw new Error(`invalid scar id ${JSON.stringify(id)}`);
  }
  const dir = memoryDir();
  const candidate = resolve(join(dir, `${id}.md`));
  if (!candidate.startsWith(resolve(dir) + sep)) {
    throw new Error(`invalid scar id ${JSON.stringify(id)}`);
  }
  return id;
}

export function newScarId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

export type ScarWrite = {
  scarId: string;
  sessionRef: string;
  eventRefs: string[];
  taint?: "tool_output";
  hash: string;
  path: string;
};

/** Writes a scar file to ~/.raziel/memory/<id>.md — provenance header (session
 * id, event ids, taint) followed by the scar text — and returns the fields a
 * caller needs to emit a memory_write event. No read side, no session-log
 * coupling: v1.1a is capture-only (§4 of docs/milestones/2026-09-05). */
export function writeScar(
  text: string,
  sessionRef: string,
  eventRefs: string[],
  taint: "tool_output" | undefined,
  id: string = newScarId(),
): ScarWrite {
  const scarId = validateScarId(id);
  const path = join(memoryDir(), `${scarId}.md`);
  const body = [
    "---",
    `scarId: ${scarId}`,
    `sessionRef: ${sessionRef}`,
    `eventRefs: ${JSON.stringify(eventRefs)}`,
    `taint: ${taint ?? "none"}`,
    "---",
    "",
    text.trimEnd(),
    "",
  ].join("\n");
  writeFileSync(path, body);
  const hash = createHash("sha256").update(body).digest("hex");
  return { scarId, sessionRef, eventRefs, taint, hash, path };
}
