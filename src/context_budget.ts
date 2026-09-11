import type { ChatMessage } from "./provider";
import { canonicalJson } from "./tools/types";

/** Heuristic, NOT a tokenizer: ceil(chars / 4), counting the JSON-serialized
 * ChatMessage array. This includes all user/assistant text, call args JSON and
 * result outputs, plus ids, names, escaping and structural overhead. JS length
 * counts UTF-16 code units, not bytes or model tokens. Provider-specific framing,
 * system prompts, tool declarations and output reserves are not available here;
 * the 60% trigger / 50% target leave headroom, not a guarantee against overflow.
 */
function estimate(chars: number): number { return Math.ceil(chars / 4); }

/** A disposable wire view. The log never changes: no mutation, summary, I/O or
 * persisted eviction state. Protected content may exceed even the full budget.
 * Only old successful result outputs can shrink, and every slot stays put.
 */
export function applyBudget(
  msgs: ChatMessage[],
  opts: { contextTokens: number; keepRecentRounds?: number; minEvictChars?: number },
): { msgs: ChatMessage[]; evicted: number; estimatedTokens: number } {
  let chars = JSON.stringify(msgs).length;
  let estimatedTokens = estimate(chars);
  if (estimatedTokens <= 0.6 * opts.contextTokens) return { msgs, evicted: 0, estimatedTokens };

  const keepRecentRounds = Math.max(0, Math.floor(opts.keepRecentRounds ?? 2));
  const minEvictChars = opts.minEvictChars ?? 2000;
  // Recency is scoped to the CURRENT turn: only tool rounds after the newest
  // user message can be "recent". Everything before it is history and is
  // eligible oldest-first. (First cut counted rounds across the whole session,
  // so a previous turn's single big round stayed protected forever -- observed
  // live: six reads, 32k of context, a new turn, nothing evicted.)
  let turnStart = msgs.length - 1;
  while (turnStart > 0 && msgs[turnStart]!.role !== "user") turnStart--;
  const isRound = (m: ChatMessage): boolean => m.role === "assistant" && (m.toolCalls?.length ?? 0) > 0;
  const roundsInTurn = msgs.slice(turnStart).filter(isRound).length;
  let round = 0; // counted within the current turn only
  let evicted = 0;
  let view = msgs;
  for (let mi = 0; mi < msgs.length && estimatedTokens > 0.5 * opts.contextTokens; mi++) {
    const m = msgs[mi]!;
    if (mi >= turnStart && isRound(m)) round++;
    if (m.role !== "tool") continue;
    if (mi >= turnStart && round > roundsInTurn - keepRecentRounds) continue;
    const preceding = msgs[mi - 1];
    if (preceding?.role !== "assistant" || !preceding.toolCalls?.length) continue;
    const calls = preceding.toolCalls;
    let out = m.results;
    for (let ri = 0; ri < m.results.length && estimatedTokens > 0.5 * opts.contextTokens; ri++) {
      const result = m.results[ri]!;
      if (!result.ok || result.output.length < minEvictChars) continue;
      // Local to this round: provider ids can repeat in every response. Id wins
      // over position for args only. Neither the calls nor results are reordered.
      const call = calls.find(c => c.id === result.id) ?? calls[ri];
      if (!call) continue;
      const args = canonicalJson(call.args);
      if (typeof args !== "string") continue; // no JSON args recorded; never invent
      const length = String(result.output.length).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
      const output = `[evicted from context: ${call.name} ${args.slice(0, 200)} → ${length} chars; call the tool again if you need it]`;
      if (output.length >= result.output.length) continue;
      const saved = JSON.stringify(result.output).length - JSON.stringify(output).length;
      if (saved <= 0) continue;
      if (view === msgs) view = msgs.slice();
      if (out === m.results) out = m.results.slice();
      out[ri] = { ...result, output };
      view[mi] = { ...m, results: out };
      chars -= saved;
      estimatedTokens = estimate(chars);
      evicted++;
    }
  }
  return { msgs: view, evicted, estimatedTokens };
}
