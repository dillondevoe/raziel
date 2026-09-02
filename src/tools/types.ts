import { createHash } from "node:crypto";

export type RiskClass = "low" | "medium" | "high" | "critical";
export type Provenance = "provider_structured";

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const rec = v as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`).join(",")}}`;
}

export function argsHash(tool: string, args: unknown): string {
  return createHash("sha256").update(canonicalJson({ tool, args })).digest("hex");
}
