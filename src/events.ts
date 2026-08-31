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

export function mkEvent<T extends SessionEvent["type"]>(type: T, fields: Body<T>): SessionEvent {
  return { type, id: crypto.randomUUID(), ts: new Date().toISOString(), ...fields } as SessionEvent;
}
