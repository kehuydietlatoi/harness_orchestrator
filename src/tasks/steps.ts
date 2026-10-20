/**
 * The autonomous loop's decision table. Pure: it maps *observed facts* about one task's
 * pull request to the single next step, and performs no I/O. Signals (a harness exiting,
 * a review landing) only wake the loop; this function re-derives the answer from facts
 * every time, so a lost or duplicated signal can never put a task in the wrong place.
 */

import type { CascadeRoute } from "../config.js";

export type ChecksFact = "pass" | "fail" | "pending" | "none";
export type MergeableFact = "clean" | "conflicting" | "unknown";

export interface PrStepFacts {
  number: number;
  head: string;
  checks: ChecksFact;
  mergeable: MergeableFact;
}

export interface StepFacts {
  observe?: { required: boolean; state: "missing" | "verified" | "not-verified" | "blocked" };
  observeReason?: string;
  /** A successful local push has not yet settled in GitHub's observations. */
  pushPending?: boolean;
  /** A complete PR path observation rejected the worker's scope. */
  scopeFailure?: string | null;
  /** Failed fix-type attempts on this head and route, supplied by the coordinator. */
  failedFixAttempts?: number;
  /** Policy-validated next member; absent preserves the existing retry policy. */
  nextCascade?: CascadeRoute | null;
  /** The issue carries `needs-attention`: a human owns it until they clear it. */
  attention: boolean;
  /** Cumulative ticket spend blocks agent runs, including lead triage. */
  budgetSpent?: boolean;
  /** The task's open pull request, or null before submission / after merge. */
  pr: PrStepFacts | null;
  review: {
    /** The current head carries an acceptable approval (see `reviewSatisfied`). */
    approved: boolean;
    /** The latest decision on the current head requests changes. */
    changesRequested: boolean;
  };
  /** Fix / conflict rounds already spent on this task. */
  rounds: number;
  maxRounds: number;
  requireHumanMerge: boolean;
  /** Lead triages already recorded on this PR (ADR-0010). Absent counts as 0. */
  triages?: number;
  /** Triages allowed before a stuck task goes to a human (`maxLeadTriage`). Absent counts as 0: no triage. */
  maxTriages?: number;
  /** Extra fix rounds granted by triage decisions. Absent counts as 0. */
  extraRounds?: number;
}

export type Step =
  /** A failed fix switches to the next configured member before another writable run. */
  | { kind: "cascade"; route: CascadeRoute }
  /** Nothing for orch to do (no PR yet, or a human owns it). */
  | { kind: "none"; reason: string }
  /** Run a read-only review of the current head. */
  | { kind: "review" }
  | { kind: "observe" }
  /** Resume the author to address review feedback or a red CI. */
  | { kind: "fix"; reason: "review" | "ci" | "observe" }
  /** Merge the base branch into the PR branch and resolve conflicts. */
  | { kind: "resolve-conflict" }
  | { kind: "merge" }
  /** Ready to merge but policy requires a human to press the button. */
  | { kind: "await-human"; reason: string }
  /** Something external (CI, GitHub's mergeability computation) must settle first. */
  | { kind: "wait"; reason: string }
  /** Too many rounds without converging: ask the lead whether one more guided round can finish it. */
  | { kind: "triage"; reason: string }
  /** Too many rounds without converging: hand the task to a human. */
  | { kind: "escalate"; reason: string };

/** Steps that spend an agent run (and count toward the round budget when they change code). */
export const AGENT_STEPS: ReadonlySet<Step["kind"]> = new Set(["cascade", "observe", "review", "fix", "resolve-conflict", "triage"]);

/** Budget exhaustion bypasses triage; merge and external waits need no new run. */
export function applyBudget(step: Step, spent: boolean): Step {
  return spent && AGENT_STEPS.has(step.kind) ? { kind: "escalate", reason: "budget spent" } : step;
}

/**
 * Precedence, highest first:
 *   needs-attention -> no PR -> changes requested -> red CI -> conflict -> observe -> review -> settle -> merge.
 * Conflicts are resolved *before* review so a head that is about to change is never reviewed,
 * and review happens before waiting on CI so the two overlap. A fix-type step whose round
 * budget (`maxRounds` plus any rounds a triage granted) is spent goes to the lead for triage
 * while its triage budget lasts, and to a human after that.
 */
export function decideStep(f: StepFacts): Step {
  return applyBudget(decidePrStep(f), f.budgetSpent ?? false);
}

function decidePrStep(f: StepFacts): Step {
  if (f.attention) return { kind: "none", reason: "needs-attention: a human owns this task" };
  const pr = f.pr;
  if (!pr) return { kind: "none", reason: "no open pull request" };
  if (f.scopeFailure) return { kind: "escalate", reason: f.scopeFailure };
  if (f.pushPending) return { kind: "wait", reason: "GitHub is still updating the pushed head and mergeability" };

  const extra = f.extraRounds ?? 0;
  const exhausted = f.rounds >= f.maxRounds + extra;
  const spent = (what: string): Step => ({
    kind: (f.triages ?? 0) < (f.maxTriages ?? 0) ? "triage" : "escalate",
    reason: `${what} after ${f.rounds} fix round${f.rounds === 1 ? "" : "s"} ` +
      `(limit ${f.maxRounds}${extra ? ` + ${extra} granted by triage` : ""})`,
  });

  // A CI fix that could not change the failing head needs a human, not a pricier run.
  // Review feedback retains its precedence when both gates are red.
  if ((f.failedFixAttempts ?? 0) >= 1 && !f.review.changesRequested && pr.checks === "fail") {
    return { kind: "escalate", reason: "CI is still failing after a failed fix attempt; a human needs to investigate" };
  }

  if ((f.failedFixAttempts ?? 0) >= 1 && f.nextCascade &&
      (f.review.changesRequested || pr.checks === "fail" || pr.mergeable === "conflicting" || (f.observe?.required && f.observe.state === "not-verified"))) {
    return { kind: "cascade", route: f.nextCascade };
  }

  if (f.review.changesRequested) {
    return exhausted ? spent("review feedback is still unresolved") : { kind: "fix", reason: "review" };
  }
  if (pr.checks === "fail") {
    return exhausted ? spent("CI is still failing") : { kind: "fix", reason: "ci" };
  }
  if (pr.mergeable === "conflicting") {
    return exhausted ? spent("the branch still conflicts with the base") : { kind: "resolve-conflict" };
  }
  if (f.observe?.required) {
    if (f.observe.state === "missing") return { kind: "observe" };
    if (f.observe.state === "not-verified") return exhausted ? spent("observe acceptance is still unresolved") : { kind: "fix", reason: "observe" };
    if (f.observe.state === "blocked") return { kind: "escalate", reason: f.observeReason || "observe verifier blocked" };
  }
  if (!f.review.approved) return { kind: "review" };

  if (pr.checks === "pending") return { kind: "wait", reason: "CI is still running" };
  if (pr.mergeable === "unknown") return { kind: "wait", reason: "GitHub is still computing mergeability" };

  return f.requireHumanMerge
    ? { kind: "await-human", reason: "approved and green; requireHumanMerge is on" }
    : { kind: "merge" };
}
