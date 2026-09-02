export type ParserKind = "native"; // M1b adds "hermes-json" | "qwen-xml"

export type ModelProfile = {
  id: string; // registry key AND what /model matches
  provider: "anthropic" | "ollama" | "openai-compat";
  model: string; // provider-side model name
  baseUrl?: string; // ollama / openai-compat endpoints
  contextTokens: number; // budget the engine may assume
  maxToolSurface: number; // enforced in M1b; carried now
  parser: ParserKind;
  sampling?: { temperature?: number; topP?: number };
  streamingTools: boolean; // carried for M1b
  escalateTo?: string; // profile id offered on local punt (M1c UX)
};

// qwen numbers are the landscape-scan doctrine: 32K forced context, small
// tool surface, 0.7/0.8 sampling, never greedy.
const REGISTRY: ModelProfile[] = [
  { id: "sonnet", provider: "anthropic", model: "claude-sonnet-5",
    contextTokens: 200_000, maxToolSurface: 24, parser: "native", streamingTools: true },
  { id: "qwen", provider: "ollama", model: "qwen3.5:9b",
    baseUrl: "http://127.0.0.1:11434", contextTokens: 32_768, maxToolSurface: 6,
    parser: "native", sampling: { temperature: 0.7, topP: 0.8 }, streamingTools: false,
    escalateTo: "sonnet" },
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
