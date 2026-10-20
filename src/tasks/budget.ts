import type { EffortTier, OrchConfig } from "../config.js";

export interface Budget { minutes?: number; usd?: number; requests?: number }

export function validateBudget(value: unknown): asserts value is Budget {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Budget must be an object");
  for (const [key, n] of Object.entries(value)) {
    if (!["minutes", "usd", "requests"].includes(key) || typeof n !== "number" || !Number.isFinite(n) || n < 0 ||
        (key === "requests" && !Number.isInteger(n))) throw new Error(`Invalid budget ${key}: ${String(n)}`);
  }
}

/** Line-level issue overrides, like Depends-on. Malformed caps fail closed. */
export function parseBudget(body: string): Budget | undefined {
  const line = /^Budget:[ \t]*(.*)$/im.exec(body)?.[1].trim();
  if (line === undefined) return undefined;
  const budget: Budget = {};
  for (const token of line.split(/\s+/)) {
    const m = /^(?:(\d+(?:\.\d+)?)m|\$(\d+(?:\.\d+)?)|(\d+)req)$/i.exec(token);
    if (!m) throw new Error(`Invalid Budget token: ${token}`);
    const key = m[1] !== undefined ? "minutes" : m[2] !== undefined ? "usd" : "requests";
    if (budget[key] !== undefined) throw new Error(`Duplicate Budget ${key}`);
    budget[key] = Number(m[1] ?? m[2] ?? m[3]);
  }
  validateBudget(budget);
  return budget;
}

/** Defaults < tier < issue, merged per dimension. */
export function resolveBudget(cfg: Pick<OrchConfig, "budgets">, tier: EffortTier, body: string): Budget | undefined {
  const issue = parseBudget(body);
  if (!cfg.budgets && !issue) return undefined;
  return { ...cfg.budgets?.default, ...cfg.budgets?.byTier?.[tier], ...issue };
}

/** Caller supplies this issue's records across all phases and agents. One invocation
 * is one request; legacy records predate the explicit count. Unknown USD fails closed;
 * callers map flat-rate (non-API) runs to $0 first. */
export function budgetStatus(
  runs: readonly { durationMs: number; costUsd: number | null; requests?: number }[],
  budget: Budget = {},
) {
  const minutes = runs.reduce((n, r) => n + r.durationMs / 60_000, 0);
  const usd = runs.some((r) => r.costUsd === null) ? null : runs.reduce((n, r) => n + (r.costUsd ?? 0), 0);
  const requests = runs.reduce((n, r) => n + (r.requests ?? 1), 0);
  const remaining: Budget = {};
  if (budget.minutes !== undefined) remaining.minutes = Math.max(0, budget.minutes - minutes);
  if (budget.usd !== undefined) remaining.usd = usd === null ? 0 : Math.max(0, budget.usd - usd);
  if (budget.requests !== undefined) remaining.requests = Math.max(0, budget.requests - requests);
  return { used: { minutes, usd, requests }, remaining, spent: Object.values(remaining).some((n) => n <= 0) };
}
