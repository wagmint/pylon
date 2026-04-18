import type { TokenUsage } from "../types/index.js";

// ─── Model Pricing ──────────────────────────────────────────────────────────

export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/** Prefix-matching table — most-specific prefixes first to avoid shadowing */
const PRICING_TABLE: Array<[string, ModelPricing]> = [
  // Anthropic — specific versions before generic
  ["claude-opus-4-6",    { input: 15e-6, output: 75e-6, cacheRead: 1.5e-6,  cacheCreation: 18.75e-6 }],
  ["claude-opus-4-5",    { input: 15e-6, output: 75e-6, cacheRead: 1.5e-6,  cacheCreation: 18.75e-6 }],
  ["claude-opus-4-1",    { input: 15e-6, output: 75e-6, cacheRead: 1.5e-6,  cacheCreation: 18.75e-6 }],
  ["claude-opus-4",      { input: 15e-6, output: 75e-6, cacheRead: 1.5e-6,  cacheCreation: 18.75e-6 }],
  ["claude-sonnet-4",    { input: 3e-6,  output: 15e-6, cacheRead: 0.3e-6,  cacheCreation: 3.75e-6 }],
  ["claude-sonnet-3-5",  { input: 3e-6,  output: 15e-6, cacheRead: 0.3e-6,  cacheCreation: 3.75e-6 }],
  ["claude-haiku-4-5",   { input: 0.8e-6, output: 4e-6, cacheRead: 0.08e-6, cacheCreation: 1e-6 }],
  ["claude-haiku-3-5",   { input: 0.8e-6, output: 4e-6, cacheRead: 0.08e-6, cacheCreation: 1e-6 }],
  // OpenAI Codex — most-specific first (per openai.com/api/pricing)
  ["gpt-5.3-codex",      { input: 1.75e-6, output: 14e-6,  cacheRead: 0.175e-6, cacheCreation: 0 }],
  ["gpt-5.2-codex",      { input: 1.75e-6, output: 14e-6,  cacheRead: 0.175e-6, cacheCreation: 0 }],
  ["gpt-5.1-codex-mini", { input: 0.25e-6, output: 2e-6,   cacheRead: 0.025e-6, cacheCreation: 0 }],
  ["gpt-5.1-codex-max",  { input: 1.25e-6, output: 10e-6,  cacheRead: 0.125e-6, cacheCreation: 0 }],
  ["gpt-5.1-codex",      { input: 1.25e-6, output: 10e-6,  cacheRead: 0.125e-6, cacheCreation: 0 }],
  ["gpt-5-codex",        { input: 1.25e-6, output: 10e-6,  cacheRead: 0.125e-6, cacheCreation: 0 }],
  ["codex-mini",         { input: 1.5e-6,  output: 6e-6,   cacheRead: 0.375e-6, cacheCreation: 0 }],
  // OpenAI non-Codex
  ["gpt-5.4",            { input: 2.5e-6, output: 10e-6,  cacheRead: 0.625e-6, cacheCreation: 0 }],
  ["gpt-5.2",            { input: 2e-6,   output: 8e-6,   cacheRead: 0.5e-6,   cacheCreation: 0 }],
  ["gpt-5.1",            { input: 1e-6,   output: 4e-6,   cacheRead: 0.25e-6,  cacheCreation: 0 }],
  ["gpt-5",              { input: 2e-6,   output: 8e-6,   cacheRead: 0.5e-6,   cacheCreation: 0 }],
  ["o4-mini",            { input: 1.1e-6, output: 4.4e-6, cacheRead: 0.275e-6, cacheCreation: 0 }],
  ["o3-pro",             { input: 20e-6,  output: 80e-6,  cacheRead: 5e-6,     cacheCreation: 0 }],
  ["o3-mini",            { input: 1.1e-6, output: 4.4e-6, cacheRead: 0.55e-6,  cacheCreation: 0 }],
  ["o3",                 { input: 2e-6,   output: 8e-6,   cacheRead: 0.5e-6,   cacheCreation: 0 }],
  ["gpt-4.1-mini",       { input: 0.4e-6, output: 1.6e-6, cacheRead: 0.1e-6,   cacheCreation: 0 }],
  ["gpt-4.1-nano",       { input: 0.1e-6, output: 0.4e-6, cacheRead: 0.025e-6, cacheCreation: 0 }],
  ["gpt-4.1",            { input: 2e-6,   output: 8e-6,   cacheRead: 0.5e-6,   cacheCreation: 0 }],
  ["gpt-4o-mini",        { input: 0.15e-6, output: 0.6e-6, cacheRead: 0.075e-6, cacheCreation: 0 }],
  ["gpt-4o",             { input: 2.5e-6, output: 10e-6,  cacheRead: 1.25e-6,  cacheCreation: 0 }],
];

/** Default pricing for unknown models */
const DEFAULT_PRICING: ModelPricing = PRICING_TABLE[4][1]; // Sonnet 4 pricing

/** Shown in UI so users know rates are approximate */
export const PRICING_UPDATED = "2026-03-27";

/** Bump when PRICING_TABLE rates change — stored on each turn row for auditing */
export const PRICING_VERSION = 1;

export function getModelPricing(model: string | null): ModelPricing {
  if (!model) return DEFAULT_PRICING;
  const lower = model.toLowerCase();
  for (const [prefix, pricing] of PRICING_TABLE) {
    if (lower.startsWith(prefix)) return pricing;
  }
  return DEFAULT_PRICING;
}

export function computeTurnCost(model: string | null, usage: TokenUsage): number {
  const p = getModelPricing(model);
  return (
    usage.inputTokens * p.input +
    usage.outputTokens * p.output +
    usage.cacheReadInputTokens * p.cacheRead +
    usage.cacheCreationInputTokens * p.cacheCreation
  );
}

/** Stable lowercase slug for GROUP BY — null/unknown → "unknown" */
export function normalizeModelFamily(model: string | null): string {
  if (!model) return "unknown";
  const lower = model.toLowerCase();
  // Anthropic — specific versions first
  if (lower.startsWith("claude-opus-4-6")) return "opus-4.6";
  if (lower.startsWith("claude-opus-4-5")) return "opus-4.5";
  if (lower.startsWith("claude-opus-4-1")) return "opus-4.1";
  if (lower.startsWith("claude-opus-4")) return "opus-4";
  if (lower.startsWith("claude-sonnet-4-6")) return "sonnet-4.6";
  if (lower.startsWith("claude-sonnet-4-5")) return "sonnet-4.5";
  if (lower.startsWith("claude-sonnet-4")) return "sonnet-4";
  if (lower.startsWith("claude-sonnet-3-5") || lower.startsWith("claude-sonnet-3.5")) return "sonnet-3.5";
  if (lower.startsWith("claude-haiku-4-5") || lower.startsWith("claude-haiku-4.5")) return "haiku-4.5";
  if (lower.startsWith("claude-haiku-3-5") || lower.startsWith("claude-haiku-3.5")) return "haiku-3.5";
  if (lower.startsWith("claude-haiku")) return "haiku";
  if (lower.startsWith("claude-sonnet")) return "sonnet";
  if (lower.startsWith("claude-opus")) return "opus";
  // OpenAI Codex
  if (lower.startsWith("gpt-5.3-codex")) return "codex-5.3";
  if (lower.startsWith("gpt-5.2-codex")) return "codex-5.2";
  if (lower.startsWith("gpt-5.1-codex-mini")) return "codex-mini-5.1";
  if (lower.startsWith("gpt-5.1-codex-max")) return "codex-max-5.1";
  if (lower.startsWith("gpt-5.1-codex")) return "codex-5.1";
  if (lower.startsWith("gpt-5-codex")) return "codex-5";
  if (lower.startsWith("codex-mini")) return "codex-mini";
  if (lower === "codex" || lower.startsWith("codex-")) return "codex";
  // OpenAI non-Codex
  if (lower.startsWith("gpt-5.4")) return "gpt-5.4";
  if (lower.startsWith("gpt-5.2")) return "gpt-5.2";
  if (lower.startsWith("gpt-5.1")) return "gpt-5.1";
  if (lower.startsWith("gpt-5")) return "gpt-5";
  if (lower.startsWith("o4-mini")) return "o4-mini";
  if (lower.startsWith("o3-pro")) return "o3-pro";
  if (lower.startsWith("o3-mini")) return "o3-mini";
  if (lower.startsWith("o3")) return "o3";
  if (lower.startsWith("gpt-4.1-mini")) return "gpt-4.1-mini";
  if (lower.startsWith("gpt-4.1-nano")) return "gpt-4.1-nano";
  if (lower.startsWith("gpt-4.1")) return "gpt-4.1";
  if (lower.startsWith("gpt-4o-mini")) return "gpt-4o-mini";
  if (lower.startsWith("gpt-4o")) return "gpt-4o";
  return "unknown";
}

/** Like computeTurnCost but returns 0 for null/unknown models (no Sonnet fallback) */
export function computeStoredTurnCost(model: string | null, usage: TokenUsage): number {
  if (!model) return 0;
  const lower = model.toLowerCase();
  for (const [prefix, p] of PRICING_TABLE) {
    if (lower.startsWith(prefix)) {
      return (
        usage.inputTokens * p.input +
        usage.outputTokens * p.output +
        usage.cacheReadInputTokens * p.cacheRead +
        usage.cacheCreationInputTokens * p.cacheCreation
      );
    }
  }
  return 0;
}

/** "claude-sonnet-4-20250514" → "Sonnet 4", "claude-opus-4-6" → "Opus 4.6" */
export function shortModelName(model: string): string {
  const lower = model.toLowerCase();
  // Anthropic — specific versions first
  if (lower.startsWith("claude-opus-4-6")) return "Opus 4.6";
  if (lower.startsWith("claude-opus-4-5")) return "Opus 4.5";
  if (lower.startsWith("claude-opus-4-1")) return "Opus 4.1";
  if (lower.startsWith("claude-opus-4")) return "Opus 4";
  if (lower.startsWith("claude-sonnet-4-6")) return "Sonnet 4.6";
  if (lower.startsWith("claude-sonnet-4-5")) return "Sonnet 4.5";
  if (lower.startsWith("claude-sonnet-4")) return "Sonnet 4";
  if (lower.startsWith("claude-sonnet-3-5") || lower.startsWith("claude-sonnet-3.5")) return "Sonnet 3.5";
  if (lower.startsWith("claude-haiku-4-5") || lower.startsWith("claude-haiku-4.5")) return "Haiku 4.5";
  if (lower.startsWith("claude-haiku-3-5") || lower.startsWith("claude-haiku-3.5")) return "Haiku 3.5";
  if (lower.startsWith("claude-haiku")) return "Haiku";
  if (lower.startsWith("claude-sonnet")) return "Sonnet";
  if (lower.startsWith("claude-opus")) return "Opus";
  // OpenAI
  if (lower.startsWith("gpt-5.3-codex")) return "GPT-5.3 Codex";
  if (lower.startsWith("gpt-5.2-codex")) return "GPT-5.2 Codex";
  if (lower.startsWith("gpt-5.1-codex-mini")) return "Codex Mini 5.1";
  if (lower.startsWith("gpt-5.1-codex-max")) return "Codex Max 5.1";
  if (lower.startsWith("gpt-5.1-codex")) return "Codex 5.1";
  if (lower.startsWith("gpt-5-codex")) return "Codex 5";
  if (lower.startsWith("gpt-5.4")) return "GPT-5.4";
  if (lower.startsWith("gpt-5.2")) return "GPT-5.2";
  if (lower.startsWith("gpt-5.1")) return "GPT-5.1";
  if (lower.startsWith("gpt-5")) return "GPT-5";
  if (lower.startsWith("codex-mini")) return "Codex Mini";
  if (lower === "codex" || lower.startsWith("codex-")) return "Codex";
  if (lower.startsWith("o4-mini")) return "o4-mini";
  if (lower.startsWith("o3-pro")) return "o3-pro";
  if (lower.startsWith("o3-mini")) return "o3-mini";
  if (lower.startsWith("o3")) return "o3";
  if (lower.startsWith("gpt-4.1-mini")) return "GPT-4.1 Mini";
  if (lower.startsWith("gpt-4.1-nano")) return "GPT-4.1 Nano";
  if (lower.startsWith("gpt-4.1")) return "GPT-4.1";
  if (lower.startsWith("gpt-4o-mini")) return "GPT-4o Mini";
  if (lower.startsWith("gpt-4o")) return "GPT-4o";
  return model;
}
