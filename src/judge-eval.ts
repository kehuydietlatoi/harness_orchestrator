import { selectUnassigned, type PlanEntry } from "./assign.js";
import type { OrchConfig } from "./config.js";
import type { Issue } from "./github.js";

/**
 * Judge evaluation — the deterministic half of "is the routing judge any good?".
 *
 * Two questions are worth asking of an LLM-as-judge, and they need different tools:
 *
 *  - **Validity** — does the reply obey the contract? Every unassigned issue routed
 *    exactly once, to a configured agent, at a real effort tier, with a rationale.
 *    This is checkable offline with no ground truth, so it lives here as a pure
 *    function and runs in CI (deterministically over fixtures, and — opt-in — over
 *    a live model's real output; see `test/judge-eval.test.ts`).
 *  - **Quality** — are the routes *good*? That needs outcome labels (did the routed
 *    agent actually finish, cheaper/greener than the alternative?), i.e. an offline
 *    replay of `runs.jsonl`. That is a data problem, not a parsing one; the design
 *    is written up in `docs/adr/0005-judge-evaluation.md` rather than faked here.
 *
 * `applyPlan` (src/assign.ts) is the *write-time* subset of these checks: it drops
 * invalid/duplicate/unknown entries as non-fatal skips. It cannot see the two
 * completeness failures — a *missing* issue is simply one it never hears about, and
 * a blank rationale is not its concern — so those are the checks this module adds.
 */

export type ViolationKind =
  | "coverage-missing" // an unassigned open issue the plan never routes
  | "coverage-extra" // a routed issue that is not open + unassigned (closed, unknown, or already pinned)
  | "duplicate" // the same issue routed more than once
  | "invalid-agent" // agent is not one of the configured agents
  | "invalid-effort" // effort is neither "easy" nor "hard"
  | "missing-rationale"; // the contract requires one grounded sentence

export interface Violation {
  kind: ViolationKind;
  issue: number;
  detail: string;
}

export interface EvalReport {
  /** Sorted numbers of the open, unassigned issues the plan was supposed to cover. */
  expected: number[];
  /** Sorted, de-duplicated issue numbers the plan actually touched. */
  routed: number[];
  violations: Violation[];
  /** True iff the plan is contract-valid: complete, unique, and well-formed. */
  ok: boolean;
}

const VALID_EFFORTS = new Set(["easy", "hard"]);

/**
 * Score a judge plan against the issues it was asked to route. Pure and offline —
 * no IO, no model call. Returns every contract violation (not just the first) so a
 * caller can report the full picture. Order is stable: sorted by issue, then kind.
 */
export function evaluatePlan(
  plan: readonly PlanEntry[],
  issues: readonly Issue[],
  cfg: Pick<OrchConfig, "agents">,
): EvalReport {
  const expectedNumbers = selectUnassigned(issues)
    .map((issue) => issue.number)
    .sort((a, b) => a - b);
  const expected = new Set(expectedNumbers);
  const agents = new Set(cfg.agents);

  const seen = new Set<number>();
  const violations: Violation[] = [];

  for (const entry of plan) {
    if (seen.has(entry.issue)) {
      violations.push({ kind: "duplicate", issue: entry.issue, detail: "routed more than once" });
    } else {
      seen.add(entry.issue);
      if (!expected.has(entry.issue)) {
        violations.push({
          kind: "coverage-extra",
          issue: entry.issue,
          detail: "not an open, unassigned issue",
        });
      }
    }
    if (!agents.has(entry.agent)) {
      violations.push({
        kind: "invalid-agent",
        issue: entry.issue,
        detail: `agent '${entry.agent}' is not configured (expected one of: ${cfg.agents.join(", ")})`,
      });
    }
    if (!VALID_EFFORTS.has(entry.effort)) {
      violations.push({
        kind: "invalid-effort",
        issue: entry.issue,
        detail: `effort '${entry.effort}' is neither easy nor hard`,
      });
    }
    if (!(entry.rationale ?? "").trim()) {
      violations.push({ kind: "missing-rationale", issue: entry.issue, detail: "empty rationale" });
    }
  }

  for (const number of expectedNumbers) {
    if (!seen.has(number)) {
      violations.push({ kind: "coverage-missing", issue: number, detail: "no plan entry" });
    }
  }

  violations.sort((a, b) => a.issue - b.issue || a.kind.localeCompare(b.kind));

  return {
    expected: expectedNumbers,
    routed: [...seen].sort((a, b) => a - b),
    violations,
    ok: violations.length === 0,
  };
}

/** One-line human summary of a report, e.g. "3/3 routed, valid". Pure. */
export function summarizeReport(report: EvalReport): string {
  const covered = report.expected.filter((n) => report.routed.includes(n)).length;
  const head = `${covered}/${report.expected.length} routed`;
  return report.ok ? `${head}, valid` : `${head}, ${report.violations.length} violation(s)`;
}
