import { describe, expect, it } from "vitest";
import { estimateCost, DEFAULT_PRICING } from "../src/board/pricing.js";

const usage = (over: Partial<Parameters<typeof estimateCost>[0]> = {}) => ({
  tokensIn: 1_000_000,
  tokensOut: 100_000,
  cachedInputTokens: null,
  ...over,
});

describe("DEFAULT_PRICING", () => {
  it("defines Claude 5.5 input, cache-read, and output rates", () => {
    expect(DEFAULT_PRICING["claude-sonnet-5-5"]).toEqual({ input: 2, cachedInput: 0.1, output: 10 });
    expect(DEFAULT_PRICING["claude-opus-5-5"]).toEqual({ input: 4, cachedInput: 0.2, output: 20 });
  });

  it("preserves the generic aliases for older models", () => {
    expect(DEFAULT_PRICING.opus).toEqual({ input: 5, cachedInput: 0.5, output: 25 });
    expect(DEFAULT_PRICING.sonnet).toEqual({ input: 3, cachedInput: 0.3, output: 15 });
  });
});

describe("estimateCost", () => {
  it("returns zero for quota mode even when usage, model, and prices are unknown", () => {
    expect(estimateCost(usage({ tokensIn: null }), null, {}, "quota")).toBe(0);
    expect(estimateCost(usage(), "opus", DEFAULT_PRICING, "subscription")).toBeNull();
  });
  it("prices the default Sonnet 5.5 model id", () => {
    // 1M input @ $2 + 100k output @ $10/M = $3.
    expect(estimateCost(usage(), "claude-sonnet-5-5", DEFAULT_PRICING)).toBeCloseTo(3, 6);
  });

  it("estimates the default Opus 5.5 lead cost including cache reads", () => {
    // 800k cached @ $0.2/M + 200k uncached @ $4/M + 100k output @ $20/M = $2.96.
    expect(estimateCost(usage({ cachedInputTokens: 800_000 }), "claude-opus-5-5", DEFAULT_PRICING))
      .toBeCloseTo(2.96, 6);
  });

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
