export type ParserKind = "native"; // M1b adds "hermes-json" | "qwen-xml"

export type ModelProfile = {
  id: string; // registry key AND what /model matches
  provider: "anthropic" | "ollama" | "openai-compat" | "openai-responses";
  model: string; // provider-side model name
  baseUrl?: string; // ollama / openai-compat endpoints
  contextTokens: number; // budget the engine may assume
  maxToolSurface: number; // enforced in M1b; carried now
  parser: ParserKind;
  sampling?: { temperature?: number; topP?: number };
  streamingTools: boolean; // carried for M1b
  escalateTo?: string; // profile id offered on local punt (M1c UX)
  // Env var holding this profile's API key. The two pi-ai-backed providers
  // (openai-compat, openai-responses) honour it -- anthropic and ollama do
  // not read it -- and its
  // absence is meaningful: a profile WITHOUT it is a keyless endpoint
  // (Ollama/vLLM/LM Studio) and gets the provider's keyless placeholder; a
  // profile WITH it is refused at construction when the var is unset,
  // rather than sending "not-needed" upstream and surfacing a config error
  // as somebody else's 401. Per-profile because one shared var collides the
  // moment a second keyed openai-compat endpoint exists.
  apiKeyEnv?: string;
  // Path to a file whose contents become the system prompt for this
  // profile. `~/`-anchored paths are expanded against $HOME. Making the
  // persona a property of the PROFILE means a /model swap carries it,
  // instead of the user retyping it every session.
  systemFile?: string;
};

// qwen numbers are the landscape-scan doctrine: 32K forced context, small
// tool surface, 0.7/0.8 sampling, never greedy. The MODEL is measured, not
// scanned: 120-trial pre-registered tool-call benchmark, 2026-09-10 —
// qwen2.5:7b was 20/20 on both the native and prompted paths and ~12x faster
// than the 27b; both larger models dropped a call. (Wilson-95 floor: only
// 20/20 passes at n=20, so the pick is "perfect and fastest", not "best".)
//
// THE 7b PIN IS LOAD-BEARING, not a performance preference (Augur, 2026-09-10,
// after the ollama lane was re-scoped to the NATIVE channel only). His table is
// asymmetric across exactly that axis: under prompted-first all three models
// were 20/20; under native-only BOTH measured failures sit in the lane —
// qwen2.5:14b NO_CALL (19/20), qwen3.8:27b WRONG_TOOL (19/20) — and 7b is the
// only clean cell. Widening this profile to 14b or 27b "for capacity" widens
// onto the only failures measured. Two honest limits: native-vs-prompted is
// p=0.50 (not "native is worse"), and n=20 cannot pass 19/20 (a sample
// statement, not a verdict). Widen only after the native-only n=100/model
// re-run with REFUSED split out of NO_CALL clears the model you want.
//
// ⚠ THE DOOR IS NOT YET OPEN (Saga, phase 1.6 inspection, 2026-09-11; verified by
// the operator): as of 4d09d47 the ollama provider maps tool HISTORY into
// /api/chat messages but does NOT send `tools` on the request and does NOT
// parse `message.tool_calls` from the NDJSON stream. maxToolSurface: 6 is
// therefore declared ahead of a working path — the exact defect the sprint rule
// names. Augur's 20/20 was measured by his own probes, not through this
// provider. The number stays only because four tests use it as the slicing
// fixture; the fix is to open the path (declare + parse + live arm), tracked as
// a sprint task, not to keep a surface nothing can reach.
const REGISTRY: ModelProfile[] = [
  { id: "sonnet", provider: "anthropic", model: "claude-sonnet-5",
    contextTokens: 200_000, maxToolSurface: 24, parser: "native", streamingTools: true },
  { id: "qwen", provider: "ollama", model: "qwen2.5:7b",
    baseUrl: "http://127.0.0.1:11434", contextTokens: 32_768, maxToolSurface: 6,
    parser: "native", sampling: { temperature: 0.7, topP: 0.8 }, streamingTools: false,
    escalateTo: "sonnet" },
  // astra: OpenAI's gpt-6-astra over the openai-compat path.
  //
  // NO `sampling` block, deliberately. Astra rejects both `temperature` and
  // `top_p`. Omitting `sampling` keeps BOTH off the wire by two independent
  // mechanisms: pi-ai's buildParams sets `temperature` only when it is
  // `!== undefined`, and our own provider only builds a `samplingParams`
  // object when `topP` is defined. Adding a sampling block here — even an
  // empty-looking one — is how this profile breaks.
  //
  // `max_tokens` is NOT controlled from here: the provider sends its own
  // DEFAULT_MAX_TOKENS unconditionally, and pi-ai's host detection maps it
  // to `max_completion_tokens` for api.openai.com. That is the field Astra
  // accepts, so this is correct — but it is correct in the dependency, not
  // because of anything this entry chooses. Do not "fix" it by adding a
  // field the registry does not read.
  //
  // contextTokens is a LOCAL budget only; it never reaches the wire. Start
  // low and raise it once measured rather than guess high.
  { id: "astra", provider: "openai-compat", model: "gpt-6-astra",
    baseUrl: "https://api.openai.com/v1", contextTokens: 32_768, maxToolSurface: 0,
    parser: "native", streamingTools: false,
    apiKeyEnv: "RAZIEL_COMPAT_KEY",
    systemFile: "profiles/astra.md" },   // relative = under RAZIEL_HOME (~/.raziel); operator-supplied persona
  // NO tool-bearing astra profile over openai-compat, and this is MEASURED, not
  // inferred (2026-09-10, live against api.openai.com): with `tools` present
  // Chat Completions returns 400 "Function tools with reasoning_effort are not
  // supported for gpt-6-astra ... use /v1/responses or set reasoning_effort to
  // 'none'", and sending 'none' returns 400 "does not support 'none'". The two
  // errors close the door from both sides. The provider's tool channel below is
  // real and tested; it is for OTHER openai-compatible endpoints. Astra's hands
  // arrive with a Responses-API provider, as a separate profile, which is the
  // entry directly below.
  //
  // maxToolSurface: 7 is not a placeholder. Lane (b)'s door was proven by a LIVE
  // arm the operator ran on 2026-09-10 (PR #4): astra executed read_file on
  // package.json through Responses and the content came back. The addendum's
  // rule -- a profile advertising a capability with no working path is a defect --
  // is satisfied by that run, and by nothing weaker.
  //
  // systemFile is the SAME file as `astra`: the persona is a property of the
  // model the operator talks to, not of which door the request goes through.
  // Without it a /model astra -> astra-agent swap dropped the persona silently
  // (loadSystemPrompt returns undefined with no warning when no file is
  // declared), which presents as personality drift between two profiles of one
  // model (review, Geist gate 2026-09-10).
  { id: "astra-agent", provider: "openai-responses", model: "gpt-6-astra",
    baseUrl: "https://api.openai.com/v1", contextTokens: 32_768, maxToolSurface: 7,
    parser: "native", streamingTools: true, apiKeyEnv: "RAZIEL_COMPAT_KEY",
    systemFile: "profiles/astra.md" },
];
// Freeze every entry (+ its sampling sub-object) and the registry array
// itself, so callers can't mutate the registry's live objects out from
// under later readers (getProfile/listProfiles hand back the same refs).
for (const p of REGISTRY) {
  if (p.sampling) Object.freeze(p.sampling);
  Object.freeze(p);
}
Object.freeze(REGISTRY);

export function getProfile(id: string): ModelProfile | undefined {
  return REGISTRY.find((p) => p.id === id);
}

export function listProfiles(): ModelProfile[] {
  return REGISTRY;
}

export function defaultProfileId(): string {
  return "sonnet";
}
