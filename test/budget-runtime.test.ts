import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { readRuns, type RunRecord } from "../src/board/telemetry.js";
import { issueBudgetStatus, runBudget } from "../src/tasks/budget-runtime.js";

vi.mock("../src/board/telemetry.js", () => ({ readRuns: vi.fn() }));
const issue = { number: 12, title: "task", body: "", labels: [], state: "OPEN", assignees: [] };
const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  ts: "2026-01-01", project: "test", issue: 12, agent: "claude", model: null, outcome: "failed",
  durationMs: 60_000, costUsd: 0.5, tokensIn: null, tokensOut: null, tokensTotal: null, ...over,
});
beforeEach(() => vi.mocked(readRuns).mockReset());

describe("budget execution limits", () => {
  it("preserves existing timeouts and skips telemetry reads without budgets", () => {
    expect(runBudget(issue, DEFAULT_CONFIG, ".")).toEqual({ timeoutMs: DEFAULT_CONFIG.taskTimeoutMs });
    expect(readRuns).not.toHaveBeenCalled();
  });
  it("sums every phase for this issue and caps task and review timeouts", () => {
    vi.mocked(readRuns).mockReturnValue([run({ phase: "implement" }), run({ phase: "review" }),
      run({ phase: "fix" }), run({ issue: 99, durationMs: 999_000, costUsd: 100 })]);
    const cfg = { ...DEFAULT_CONFIG, budgets: { default: { minutes: 4, usd: 2, requests: 4 } } };
    expect(runBudget(issue, cfg, ".")).toEqual({ timeoutMs: 60_000, maxBudgetUsd: 0.5 });
    expect(runBudget(issue, cfg, ".", 20_000).timeoutMs).toBe(20_000);
    expect(issueBudgetStatus(issue, cfg, ".").remaining.requests).toBe(1);
  });
  it("rechecks telemetry before a fallback invocation", () => {
    vi.mocked(readRuns).mockReturnValueOnce([]).mockReturnValueOnce([run({ costUsd: null })]);
    const capped = { ...issue, body: "Budget: $2" };
    expect(runBudget(capped, DEFAULT_CONFIG, ".").maxBudgetUsd).toBe(2);
    expect(() => runBudget(capped, DEFAULT_CONFIG, ".")).toThrow("budget spent");
  });
  it("counts flat-rate runs with no reported cost as $0, but keeps unknown API cost fail-closed", () => {
    const capped = { ...issue, body: "Budget: $2" };
    vi.mocked(readRuns).mockReturnValue([run({ agent: "codex", costUsd: null }), run({ costUsd: 0.5 })]);
    expect(issueBudgetStatus(capped, DEFAULT_CONFIG, ".")).toMatchObject({ spent: false, used: { usd: 0.5 }, remaining: { usd: 1.5 } });
    vi.mocked(readRuns).mockReturnValue([run({ agent: "codex", costUsd: null }), run({ costUsd: null })]);
    expect(() => runBudget(capped, DEFAULT_CONFIG, ".")).toThrow("budget spent");
    const apiCodex = { ...DEFAULT_CONFIG, adapters: { ...DEFAULT_CONFIG.adapters, codex: { ...DEFAULT_CONFIG.adapters.codex, pricingMode: "api" as const } } };
    vi.mocked(readRuns).mockReturnValue([run({ agent: "codex", costUsd: null })]);
    expect(issueBudgetStatus(capped, apiCodex, ".").spent).toBe(true);
  });
});
