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
});
