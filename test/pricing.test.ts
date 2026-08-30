import { describe, expect, it } from "vitest";
import { estimateCost, DEFAULT_PRICING } from "../src/board/pricing.js";

const usage = (over: Partial<Parameters<typeof estimateCost>[0]> = {}) => ({
  tokensIn: 1_000_000,
  tokensOut: 100_000,
  cachedInputTokens: null,
  ...over,
});

describe("estimateCost", () => {
  it("prices opus at the published input/output rates", () => {
    // 1M input @ $5 + 100k output @ $25/M = 5 + 2.5 = 7.5
    expect(estimateCost(usage(), "opus", DEFAULT_PRICING)).toBeCloseTo(7.5, 6);
  });

  it("bills cached input at the cheaper cache-read rate", () => {
    // 800k cached @ $0.5/M + 200k uncached @ $5/M + 100k output @ $25/M
    // = 0.4 + 1.0 + 2.5 = 3.9
    const cost = estimateCost(usage({ cachedInputTokens: 800_000 }), "opus", DEFAULT_PRICING);
    expect(cost).toBeCloseTo(3.9, 6);
  });

  it("returns null for a model with no configured pricing (subscription-billed)", () => {
    // Codex effort tiers ("low"/"high") intentionally have no pricing entry.
    expect(estimateCost(usage(), "high", DEFAULT_PRICING)).toBeNull();
    expect(estimateCost(usage(), "low", DEFAULT_PRICING)).toBeNull();
  });

  it("returns null when the model is unknown or input usage is missing", () => {
    expect(estimateCost(usage(), null, DEFAULT_PRICING)).toBeNull();
    expect(estimateCost(usage({ tokensIn: null }), "opus", DEFAULT_PRICING)).toBeNull();
  });

  it("treats null output tokens as zero", () => {
    // 1M input @ $3 (sonnet), no output
    expect(estimateCost(usage({ tokensOut: null }), "sonnet", DEFAULT_PRICING)).toBeCloseTo(3, 6);
  });
});
