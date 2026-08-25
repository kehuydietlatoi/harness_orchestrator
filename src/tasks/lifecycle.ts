import { NEEDS_ATTENTION, STATUS } from "../github/labels.js";

/** Durable observations collected outside this pure module. Labels are deliberately absent. */
export interface TaskFacts {
  issue: "open" | "closed" | "missing";
  lock: boolean;
  worktree: boolean;
  branch: "absent" | "unchanged" | "ahead";
  pr: "none" | "open" | "closed" | "merged";
  /** The latest run that has not been superseded by an explicit reset/recovery. */
  telemetry: "none" | "submitted" | "failed" | "no-commits";
}

export const TASK_STATE_KINDS = [
  "ready",
  "claimed",
  "in-progress",
  "in-review",
  "needs-attention",
  "done",
  "inconsistent",
] as const;

export type TaskStateKind = (typeof TASK_STATE_KINDS)[number];

export type AttentionReason = "run-failed" | "no-commits" | "pr-closed" | "orphaned-work";

export type RecoveryAction =
  | "inspect-run-and-reset"
  | "reset-for-retry"
  | "inspect-closed-pr"
  | "restore-or-abandon-work"
  | "reconcile-facts";

export type TaskInvariant =
  | "issue-must-exist"
  | "worktree-requires-branch"
  | "worktree-requires-lock"
  | "closed-issue-forbids-lock"
  | "closed-issue-forbids-worktree"
  | "open-pr-requires-open-issue"
  | "open-pr-requires-lock"
  | "open-pr-requires-worktree"
  | "open-pr-requires-ahead-branch"
  | "merged-pr-requires-closed-issue"
  | "submitted-run-requires-pr"
  | "failed-run-forbids-open-pr"
  | "finished-run-requires-released-resources"
  | "unrecognized-fact-combination";

export interface TaskInvariantViolation {
  invariant: TaskInvariant;
  detail: string;
}

export type TaskState =
  | { kind: "ready" }
  | { kind: "claimed" }
  | { kind: "in-progress" }
  | { kind: "in-review" }
  | {
      kind: "needs-attention";
      reason: AttentionReason;
      recovery: Exclude<RecoveryAction, "reconcile-facts">;
    }
  | { kind: "done" }
  | { kind: "inconsistent"; violations: TaskInvariantViolation[]; recovery: "reconcile-facts" };

function violation(invariant: TaskInvariant, detail: string): TaskInvariantViolation {
  return { invariant, detail };
}

function invariantViolations(facts: TaskFacts): TaskInvariantViolation[] {
  const violations: TaskInvariantViolation[] = [];

  if (facts.issue === "missing") {
    violations.push(violation("issue-must-exist", "lifecycle facts must map to an observable GitHub issue"));
  }
  if (facts.worktree && facts.branch === "absent") {
    violations.push(violation("worktree-requires-branch", "a task worktree cannot exist without its branch"));
  }
  if (facts.worktree && !facts.lock) {
    violations.push(violation("worktree-requires-lock", "a task worktree must be protected by its claim lock"));
  }
  if (facts.issue === "closed" && facts.lock) {
    violations.push(violation("closed-issue-forbids-lock", "a closed issue cannot retain a claim lock"));
  }
  if (facts.issue === "closed" && facts.worktree) {
    violations.push(violation("closed-issue-forbids-worktree", "a closed issue cannot retain a task worktree"));
  }

  if (facts.pr === "open") {
    if (facts.issue !== "open") {
      violations.push(violation("open-pr-requires-open-issue", "an open task PR must map to an open issue"));
    }
    if (!facts.lock) {
      violations.push(violation("open-pr-requires-lock", "an open task PR must retain the claim lock until merge"));
    }
    if (!facts.worktree) {
      violations.push(violation("open-pr-requires-worktree", "an open task PR must retain its worktree"));
    }
    if (facts.branch !== "ahead") {
      violations.push(violation("open-pr-requires-ahead-branch", "an open task PR requires submitted commits"));
    }
  }

  if (facts.pr === "merged" && facts.issue !== "closed") {
    violations.push(violation("merged-pr-requires-closed-issue", "a merged task PR must close its issue"));
  }
  if (facts.telemetry === "submitted" && facts.pr === "none") {
    violations.push(violation("submitted-run-requires-pr", "a submitted run must have a task PR"));
  }
  if ((facts.telemetry === "failed" || facts.telemetry === "no-commits") && facts.pr === "open") {
    violations.push(violation("failed-run-forbids-open-pr", "a failed current run cannot also have an open task PR"));
  }
  if (
    (facts.telemetry === "failed" || facts.telemetry === "no-commits") &&
    (facts.lock || facts.worktree)
  ) {
    violations.push(
      violation(
        "finished-run-requires-released-resources",
        "a failed or no-commit run must release its lock and worktree",
      ),
    );
  }

  return violations;
}

/**
 * Derive the task's authoritative state from observed facts. This function performs no I/O;
 * callers collect observations, while this module owns all lifecycle precedence and invariants.
 */
export function deriveTaskState(facts: TaskFacts): TaskState {
  const violations = invariantViolations(facts);
  if (violations.length > 0) return { kind: "inconsistent", violations, recovery: "reconcile-facts" };

  if (facts.issue === "closed") return { kind: "done" };

  if (facts.pr === "closed") {
    return { kind: "needs-attention", reason: "pr-closed", recovery: "inspect-closed-pr" };
  }
  if (facts.telemetry === "failed") {
    return { kind: "needs-attention", reason: "run-failed", recovery: "inspect-run-and-reset" };
  }
  if (facts.telemetry === "no-commits") {
    return { kind: "needs-attention", reason: "no-commits", recovery: "reset-for-retry" };
  }
  if (facts.pr === "open") return { kind: "in-review" };

  if (facts.lock) {
    if (facts.worktree && facts.branch === "ahead") return { kind: "in-progress" };
    return { kind: "claimed" };
  }

  if (facts.branch === "ahead") {
    return { kind: "needs-attention", reason: "orphaned-work", recovery: "restore-or-abandon-work" };
  }
  if (facts.pr === "none" && facts.telemetry === "none") return { kind: "ready" };

  return {
    kind: "inconsistent",
    violations: [
      violation(
        "unrecognized-fact-combination",
        `no lifecycle state accepts ${JSON.stringify(facts)}`,
      ),
    ],
    recovery: "reconcile-facts",
  };
}

export type TaskEvent =
  | "claim"
  | "start-work"
  | "submit"
  | "request-changes"
  | "run-failed"
  | "merge"
  | "reset";

export type TransitionDecision =
  | { allowed: true; from: TaskStateKind; event: TaskEvent; to: TaskStateKind }
  | { allowed: false; from: TaskStateKind; event: TaskEvent; reason: string };

const TRANSITIONS: Readonly<Partial<Record<TaskStateKind, Partial<Record<TaskEvent, TaskStateKind>>>>> = {
  ready: { claim: "claimed" },
  claimed: { "start-work": "in-progress", reset: "ready" },
  "in-progress": { submit: "in-review", "run-failed": "needs-attention", reset: "ready" },
  "in-review": { "request-changes": "in-progress", merge: "done", reset: "ready" },
  "needs-attention": { reset: "ready" },
};

/** Decide whether an intended lifecycle event is legal before any adapter performs its writes. */
export function decideTaskTransition(from: TaskStateKind, event: TaskEvent): TransitionDecision {
  const to = TRANSITIONS[from]?.[event];
  if (to) return { allowed: true, from, event, to };
  const reason =
    from === "inconsistent"
      ? "reconcile contradictory observations and derive state again before transitioning"
      : `event '${event}' is not legal from '${from}'`;
  return { allowed: false, from, event, reason };
}

/** Status/review labels are a disposable projection of state, never an input to derivation. */
export function projectLifecycleLabels(state: TaskState | TaskStateKind): string[] {
  const kind = typeof state === "string" ? state : state.kind;
  switch (kind) {
    case "ready":
      return [STATUS.todo];
    case "claimed":
      return [STATUS.claimed];
    case "in-progress":
      return [STATUS.inProgress];
    case "in-review":
      return [STATUS.inReview];
    case "needs-attention":
    case "inconsistent":
      return [NEEDS_ATTENTION];
    case "done":
      return [STATUS.done];
  }
}
