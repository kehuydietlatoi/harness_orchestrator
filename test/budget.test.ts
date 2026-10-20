import { describe, expect, it } from "vitest";
import { budgetStatus, parseBudget, resolveBudget, validateBudget } from "../src/tasks/budget.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { applyBudget, decideStep } from "../src/tasks/steps.js";
import { resolvePlan } from "../src/tasks/plan.js";

describe("ticket budgets", () => {
  const runs = [{ durationMs: 60_000, costUsd: 0.5 }, { durationMs: 120_000, costUsd: 1.5 }];
  it.each([{ minutes: 3 }, { usd: 2 }, { requests: 2 }])("is spent at the cap %j", (budget) => {
    expect(budgetStatus(runs, budget).spent).toBe(true);
  });
  it("sums records and returns remaining limits", () => {
    expect(budgetStatus(runs, { minutes: 5, usd: 3, requests: 4 })).toEqual({
      spent: false, used: { minutes: 3, usd: 2, requests: 2 }, remaining: { minutes: 2, usd: 1, requests: 2 },
    });
    expect(budgetStatus([{ ...runs[0], requests: 3 }], { requests: 3 }).spent).toBe(true);
  });
  it("keeps unknown cost unknown and never authorizes a USD budget", () => {
    const unknown = [...runs, { durationMs: 1, costUsd: null }];
    expect(budgetStatus(unknown, { usd: 100 })).toMatchObject({ spent: true, used: { usd: null } });
    expect(budgetStatus(unknown, { minutes: 10 }).spent).toBe(false);
    expect(budgetStatus(unknown).spent).toBe(false);
  });
  it("allows the first run, except for an explicit zero cap", () => {
    expect(budgetStatus([], { usd: 2 }).remaining.usd).toBe(2);
    expect(budgetStatus([], { requests: 0 }).spent).toBe(true);
  });
  it("parses an optional case-insensitive line and merges dimensions", () => {
    expect(parseBudget("spec\nbUdGeT: 30m $2 60req\nDepends-on: #1")).toEqual({ minutes: 30, usd: 2, requests: 60 });
    expect(parseBudget("Budget mentioned in prose")).toBeUndefined();
    expect(resolveBudget({ budgets: { default: { minutes: 30, requests: 60 }, byTier: { easy: { usd: 1 } } } },
      "easy", "Budget: $2")).toEqual({ minutes: 30, requests: 60, usd: 2 });
    expect(resolveBudget(DEFAULT_CONFIG, "hard", "")).toBeUndefined();
  });
  it.each(["Budget:", "Budget: $oops", "Budget: 10m 20m", "Budget: -1m", "Budget: 1.5req"])("rejects malformed issue cap %s", (body) => {
    expect(() => parseBudget(body)).toThrow();
  });
  it.each([null, [], { minutes: -1 }, { usd: Infinity }, { requests: 1.5 }, { requests: "2" }])("rejects malformed config cap %j", (budget) => {
    expect(() => validateBudget(budget)).toThrow();
  });
  it("blocks every agent step while allowing merge, waiting and human ownership", () => {
    for (const step of [{ kind: "review" }, { kind: "fix", reason: "ci" }, { kind: "resolve-conflict" }, { kind: "triage", reason: "rounds" }] as const) {
      expect(applyBudget(step, true)).toEqual({ kind: "escalate", reason: "budget spent" });
    }
    expect(applyBudget({ kind: "merge" }, true)).toEqual({ kind: "merge" });
    expect(decideStep({ attention: true, budgetSpent: true, pr: null, review: { approved: false, changesRequested: false },
      rounds: 0, maxRounds: 3, requireHumanMerge: false }).kind).toBe("none");
  });
  it("warns when planning a USD-capped ticket a flat-rate agent can work on", () => {
    const cfg = { ...DEFAULT_CONFIG, budgets: { byTier: { cheap: { usd: 1 } } } };
    const warn = (t: Parameters<typeof resolvePlan>[0][number]) =>
      resolvePlan([t], { config: cfg }).warnings.filter((w) => w.includes("USD budget"));
    expect(warn({ title: "a" })).toEqual(["ticket 1 has a USD budget, but flat-rate agent(s) codex can work on it; their runs do not count toward it"]);
    expect(warn({ title: "a", agent: "codex", effort: "cheap" })).toHaveLength(1);
    expect(warn({ title: "a", agent: "claude", effort: "cheap" })).toEqual([]);
    expect(warn({ title: "a", agent: "codex", effort: "lead" })).toEqual([]);
    expect(warn({ title: "a", agent: "codex", effort: "lead", budget: { usd: 3 } })).toHaveLength(1);
    expect(resolvePlan([{ title: "a", budget: { usd: 3 } }]).warnings.filter((w) => w.includes("USD budget"))).toEqual([]);
  });
});
