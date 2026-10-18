import type { OrchConfig } from "../config.js";
import type { Issue } from "../github/github.js";
import { issueEffort } from "../board/board.js";
import { readRuns } from "../board/telemetry.js";
import { budgetStatus, resolveBudget } from "./budget.js";

export class BudgetSpentError extends Error {
  constructor() { super("budget spent"); }
}

export function issueBudgetStatus(issue: Issue, cfg: OrchConfig, cwd: string) {
  const budget = resolveBudget(cfg, issueEffort(issue, cfg.tierAliases) ?? cfg.defaultEffort ?? "lead", issue.body);
  return budgetStatus(budget ? readRuns(cwd).filter((r) => r.issue === issue.number) : [], budget);
}

/** Re-read before every invocation, including retries after their telemetry is written. */
export function runBudget(issue: Issue, cfg: OrchConfig, cwd: string, timeoutMs = cfg.taskTimeoutMs) {
  const status = issueBudgetStatus(issue, cfg, cwd);
  if (status.spent) throw new BudgetSpentError();
  return {
    timeoutMs: status.remaining.minutes === undefined ? timeoutMs : Math.min(timeoutMs, status.remaining.minutes * 60_000),
    ...(status.remaining.usd !== undefined ? { maxBudgetUsd: status.remaining.usd } : {}),
  };
}
