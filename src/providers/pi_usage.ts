import type { Usage } from "@earendil-works/pi-ai";
import type { TokenUsage } from "../provider";

// Shared by the two pi-ai-backed providers (openai-compat, openai-responses).
// Both adapters start the assistant message from the SAME zero placeholder
// (`usage: { input: 0, output: 0, ... }` with NO `reasoning` property) and both
// finalizers ALWAYS set `reasoning` when the server reported usage
// (openai-completions parseChunkUsage :1198; openai-responses-shared
// finalizeResponse :449) -- even for an all-zero report. So `reasoning` being
// absent is the one tell that nothing was measured, and it is checked here
// rather than by re-parsing SSE or testing total > 0. Optional zero breakdowns
// are ambiguous (the parsers default missing fields to zero), so they are
// omitted rather than claimed. Recheck both adapters on a pi-ai upgrade.
//
// One helper, two callers, on purpose: PR #4 shipped the Responses door with
// no usage path at all, and the first live astra-agent session recorded zero
// `usage` events against phase 1.5's "provider-measured, never estimated"
// rule. A second copy of this function would have been the next place for the
// two providers to drift.
export function reportedUsage(usage: Usage): TokenUsage | undefined {
  if (usage.reasoning === undefined) return undefined;
  return {
    input_tokens: usage.input,
    output_tokens: usage.output,
    ...(usage.reasoning > 0 ? { reasoning_tokens: usage.reasoning } : {}),
    ...(usage.cacheRead > 0 ? { cache_read_tokens: usage.cacheRead } : {}),
    ...(usage.cacheWrite > 0 ? { cache_write_tokens: usage.cacheWrite } : {}),
  };
}
