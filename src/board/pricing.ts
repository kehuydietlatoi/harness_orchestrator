import type { RunUsage } from "./telemetry.js";

/** Per-million-token USD rates for one resolved model. */
export interface ModelPricing {
  /** Uncached input tokens, $ per 1M. */
  input: number;
  /** Cached (prompt-cache read) input tokens, $ per 1M. Typically ~0.1× input. */
  cachedInput: number;
  /** Output tokens, $ per 1M. */
  output: number;
}

/**
 * Built-in rates for the Claude model aliases orch routes to (`adapters.claude.models`).
 * Sourced from Anthropic's published pricing (Opus 4.8, Sonnet 5 standard tier);
 * cache-read ≈ 0.1× input. Codex runs under a flat subscription, so it has no
 * per-token entry — its `costUsd` stays null by design. Override or extend via
 * `pricing` in orch.config.json when rates change or a new per-token agent is added.
 */
export const DEFAULT_PRICING: Record<string, ModelPricing> = {
  opus: { input: 5, cachedInput: 0.5, output: 25 },
  sonnet: { input: 3, cachedInput: 0.3, output: 15 },
};

/**
 * Estimate a run's cost from token usage and the resolved model's rates. Returns
 * null when the model has no configured pricing (e.g. subscription-billed Codex)
 * or when input token usage is unknown — a null result must never be treated as
 * zero. Cached input is billed at the cheaper cache-read rate; the remaining
 * input at the full rate. This is a *fallback*: when the harness log already
 * reports a cost, that authoritative figure is used instead of this estimate.
 */
export function estimateCost(
  usage: Pick<RunUsage, "tokensIn" | "tokensOut" | "cachedInputTokens">,
  model: string | null,
  pricing: Record<string, ModelPricing>,
): number | null {
  if (!model) return null;
  const rates = pricing[model];
  if (!rates) return null;
  if (usage.tokensIn === null) return null;

  const cached = usage.cachedInputTokens ?? 0;
  const uncachedIn = Math.max(0, usage.tokensIn - cached);
  const out = usage.tokensOut ?? 0;
  const cost = (uncachedIn * rates.input + cached * rates.cachedInput + out * rates.output) / 1_000_000;
  return Number.isFinite(cost) ? cost : null;
}
