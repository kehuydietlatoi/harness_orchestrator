/**
 * The autonomous loop's decision table. Pure: it maps *observed facts* about one task's
 * pull request to the single next step, and performs no I/O. Signals (a harness exiting,
 * a review landing) only wake the loop; this function re-derives the answer from facts
 * every time, so a lost or duplicated signal can never put a task in the wrong place.
 */

export type ChecksFact = "pass" | "fail" | "pending" | "none";
export type MergeableFact = "clean" | "conflicting" | "unknown";

export interface PrStepFacts {
  number: number;
  head: string;
  checks: ChecksFact;
  mergeable: MergeableFact;
}

export interface StepFacts {
  /** The issue carries `needs-attention`: a human owns it until they clear it. */
  attention: boolean;
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
}

export type Step =
  /** Nothing for orch to do (no PR yet, or a human owns it). */
  | { kind: "none"; reason: string }
  /** Run a read-only review of the current head. */
  | { kind: "review" }
  /** Resume the author to address review feedback or a red CI. */
  | { kind: "fix"; reason: "review" | "ci" }
  /** Merge the base branch into the PR branch and resolve conflicts. */
  | { kind: "resolve-conflict" }
  | { kind: "merge" }
  /** Ready to merge but policy requires a human to press the button. */
  | { kind: "await-human"; reason: string }
  /** Something external (CI, GitHub's mergeability computation) must settle first. */
  | { kind: "wait"; reason: string }
  /** Too many rounds without converging: hand the task to a human. */
  | { kind: "escalate"; reason: string };

/** Steps that spend an agent run (and count toward the round budget when they change code). */
export const AGENT_STEPS: ReadonlySet<Step["kind"]> = new Set(["review", "fix", "resolve-conflict"]);

/**
 * Precedence, highest first:
 *   needs-attention -> no PR -> changes requested -> red CI -> conflict -> review -> settle -> merge.
 * Conflicts are resolved *before* review so a head that is about to change is never reviewed,
 * and review happens before waiting on CI so the two overlap.
 */
export function decideStep(f: StepFacts): Step {
  if (f.attention) return { kind: "none", reason: "needs-attention: a human owns this task" };
  const pr = f.pr;
  if (!pr) return { kind: "none", reason: "no open pull request" };

  const exhausted = f.rounds >= f.maxRounds;
  const spent = (what: string): Step => ({
    kind: "escalate",
    reason: `${what} after ${f.rounds} fix round${f.rounds === 1 ? "" : "s"} (limit ${f.maxRounds})`,
  });

  if (f.review.changesRequested) {
    return exhausted ? spent("review feedback is still unresolved") : { kind: "fix", reason: "review" };
  }
  if (pr.checks === "fail") {
    return exhausted ? spent("CI is still failing") : { kind: "fix", reason: "ci" };
  }
  if (pr.mergeable === "conflicting") {
    return exhausted ? spent("the branch still conflicts with the base") : { kind: "resolve-conflict" };
  }
  if (!f.review.approved) return { kind: "review" };

  if (pr.checks === "pending") return { kind: "wait", reason: "CI is still running" };
  if (pr.mergeable === "unknown") return { kind: "wait", reason: "GitHub is still computing mergeability" };

  return f.requireHumanMerge
    ? { kind: "await-human", reason: "approved and green; requireHumanMerge is on" }
    : { kind: "merge" };
}
