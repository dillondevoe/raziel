type Base = { id: string; ts: string };

export type SessionEvent = Base & (
  | { type: "user_message"; text: string }
  | { type: "assistant_message"; turn: string; text: string }
  | { type: "turn_end"; turn: string; stop: "end" | "interrupt" | "error" }
  | { type: "error"; turn?: string; message: string }
  | { type: "tool_request"; turn: string; tool: string; args: unknown }
  | { type: "approval_request"; turn: string; requestId: string }
  | { type: "approval_decision"; requestId: string; decision: "allow" | "deny" | "always" }
  | { type: "tool_result"; turn: string; tool: string; ok: boolean; output: string }
);

export type EngineEvent = SessionEvent | { type: "assistant_delta"; turn: string; text: string };

type Body<T extends SessionEvent["type"]> =
  Omit<Extract<SessionEvent, { type: T }>, "id" | "ts" | "type">;

export function mkEvent<T extends SessionEvent["type"]>(
  type: T,
  fields: Body<T>,
): Extract<SessionEvent, { type: T }> {
  // Boundary cast: constructing a discriminated-union variant over a generic
  // discriminant is not provable by TS; fields are still compile-checked via Body<T>.
  return { type, id: crypto.randomUUID(), ts: new Date().toISOString(), ...fields } as unknown as Extract<SessionEvent, { type: T }>;
}

// --- Replay-time validation (F3, 2026-09-01 adversarial review) -----------
// `replay()` parses arbitrary JSON lines from disk; a forged-but-parseable
// object must never be trusted as a SessionEvent. Table-driven per-type
// field checks, keyed by the declared `type` discriminant.

type FieldCheck = (v: unknown) => boolean;
const str: FieldCheck = (v) => typeof v === "string";
const optStr: FieldCheck = (v) => v === undefined || typeof v === "string";
const bool: FieldCheck = (v) => typeof v === "boolean";
const anyVal: FieldCheck = () => true; // `args: unknown` — no primitive shape to enforce
const oneOf = (...allowed: string[]): FieldCheck => (v) => typeof v === "string" && allowed.includes(v);

const FIELD_CHECKS: { [T in SessionEvent["type"]]: Record<string, FieldCheck> } = {
  user_message: { text: str },
  assistant_message: { turn: str, text: str },
  turn_end: { turn: str, stop: oneOf("end", "interrupt", "error") },
  error: { turn: optStr, message: str },
  tool_request: { turn: str, tool: str, args: anyVal },
  approval_request: { turn: str, requestId: str },
  approval_decision: { requestId: str, decision: oneOf("allow", "deny", "always") },
  tool_result: { turn: str, tool: str, ok: bool, output: str },
};

/** Validates a parsed JSONL line as a well-formed SessionEvent: known `type`,
 * required base fields, and per-type required fields of the correct
 * primitive type. Used to skip forged-but-parseable lines on replay. */
export function isValidEvent(o: unknown): o is SessionEvent {
  if (typeof o !== "object" || o === null) return false;
  const rec = o as Record<string, unknown>;
  if (!str(rec.id) || !str(rec.ts)) return false;
  const type = rec.type;
  if (typeof type !== "string" || !(type in FIELD_CHECKS)) return false;
  const checks = FIELD_CHECKS[type as SessionEvent["type"]];
  return Object.entries(checks).every(([key, check]) => check(rec[key]));
}
