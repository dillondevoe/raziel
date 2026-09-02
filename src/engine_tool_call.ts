import { mkEvent, type EngineEvent, type SessionEvent } from "./events";
import type { ApprovalManager } from "./approvals";
import type { BuiltinTool } from "./tools/files";
import type { Workspace } from "./tools/workspace";
import { riskClassFor } from "./risk";
import { argsHash } from "./tools/types";
import { sanitizeForTerminal } from "./term";

export type ToolDeps = {
  registry: Map<string, BuiltinTool>;
  ws: Workspace;
  approvals: ApprovalManager;
};

export type ToolCall = { id: string; name: string; args: unknown };

function toolResult(
  turn: string,
  tool: string,
  requestId: string,
  ok: boolean,
  output: string,
): Extract<SessionEvent, { type: "tool_result" }> {
  return mkEvent("tool_result", { turn, tool, ok, output: sanitizeForTerminal(output), requestId, taint: "tool_output" });
}

async function execute(
  call: ToolCall,
  decision: "allow" | "deny",
  decidedHash: string,
  tools: ToolDeps,
): Promise<{ ok: boolean; output: string }> {
  if (decision === "deny") return { ok: false, output: "denied by user" };

  // R10: recompute from the args about to execute — must match what the
  // decision was actually made against.
  if (argsHash(call.name, call.args) !== decidedHash) {
    return { ok: false, output: "argsHash mismatch — refusing" };
  }

  const tool = tools.registry.get(call.name);
  if (!tool) return { ok: false, output: "unknown tool" };

  try {
    return await tool.run(call.args, tools.ws);
  } catch (e) {
    return { ok: false, output: e instanceof Error ? e.message : String(e) };
  }
}

/** Runs the tool call through request → risk → approval → (recheck) → execute,
 * yielding every event on the way. The recomputed argsHash (R10) guards
 * against args mutated between the approval decision and execution — it
 * must equal the hash the decision was made against, or the call is refused
 * without running.
 *
 * Two fail-safes on top of that (fix round, live-repro'd):
 * - `tools.approvals.decide()` rejecting (a thrown ask() callback, a Rules
 *   save failure, ...) must never escape uncaught — the engine never
 *   throws. Treated as a deny with an "approval error: <message>" result.
 * - The signal is checked at entry AND right after decide() resolves but
 *   BEFORE execute() — an abort that lands while decide() is in flight must
 *   still block execution even if the decision that arrives is "allow".
 * Returns `{ aborted }` so the caller can stop re-streaming after this call. */
export async function* handleToolCall(
  call: ToolCall,
  turn: string,
  tools: ToolDeps,
  tryAppend: (e: SessionEvent) => void,
  signal: AbortSignal | undefined,
): AsyncGenerator<EngineEvent, { aborted: boolean }> {
  if (signal?.aborted) return { aborted: true };

  const hash = argsHash(call.name, call.args);
  const req = mkEvent("tool_request", {
    turn, tool: call.name, args: call.args, requestId: call.id,
    provenance: "provider_structured", argsHash: hash,
  });
  tryAppend(req);
  yield req;

  const risk = riskClassFor(call.name, call.args, tools.ws);
  const areq = mkEvent("approval_request", { turn, requestId: call.id, tool: call.name, argsHash: hash, risk });
  tryAppend(areq);
  yield areq;

  let decision: "allow" | "deny";
  let decidedHash: string;
  try {
    ({ decision, argsHash: decidedHash } = await tools.approvals.decide(call.name, call.args, risk, tools.ws));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const tres = toolResult(turn, call.name, call.id, false, `approval error: ${message}`);
    tryAppend(tres);
    yield tres;
    return { aborted: false };
  }

  const adec = mkEvent("approval_decision", { requestId: call.id, decision });
  tryAppend(adec);
  yield adec;

  if (signal?.aborted) {
    const tres = toolResult(turn, call.name, call.id, false, "aborted before execution");
    tryAppend(tres);
    yield tres;
    return { aborted: true };
  }

  const result = await execute(call, decision, decidedHash, tools);
  const tres = toolResult(turn, call.name, call.id, result.ok, result.output);
  tryAppend(tres);
  yield tres;
  return { aborted: false };
}
