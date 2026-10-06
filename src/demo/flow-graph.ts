// The canonical, data-only model of how orch works. The dashboard graph and the
// generated docs both render from this; nothing here performs IO or imports
// runtime code (types only), so it compiles into any consumer.
import type { TaskStateKind } from "../tasks/lifecycle.js";
import type { Step } from "../tasks/steps.js";

export type Lane = "plan" | "route" | "run" | "review" | "autopilot" | "recovery";
export type NodeKind = "stage" | "decision" | "state" | "terminal";

export type FlowId =
  | "plan-pipeline"
  | "routing"
  | "claim-run"
  | "cross-review"
  | "autopilot-fix"
  | "ci-fix"
  | "conflict"
  | "triage"
  | "escalation"
  | "usage-limit"
  | "self-review"
  | "failure-recovery"
  | "repair"
  | "abandon"
  | "dependency-cycle"
  | "advisory-order"
  | "report";

export interface FlowNode {
  id: string;
  label: string;
  kind: NodeKind;
  lane: Lane;
  x: number;
  y: number;
  /** `file#function` the node is implemented by. */
  codeRef: string;
  adr?: string;
  summary: string;
}

export interface FlowEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  flows: FlowId[];
}

export interface FlowDef {
  id: FlowId;
  title: string;
  summary: string;
  adr?: string;
}

export const LANES: readonly { id: Lane; label: string; y: number }[] = [
  { id: "plan", label: "Plan", y: 60 },
  { id: "route", label: "Route", y: 250 },
  { id: "run", label: "Claim / run", y: 440 },
  { id: "review", label: "Review", y: 630 },
  { id: "autopilot", label: "Autopilot", y: 820 },
  { id: "recovery", label: "Recovery", y: 1010 },
];

const COL = 180;
const ROW = 60;
const X0 = 80;
const laneY = (lane: Lane): number => LANES.find((l) => l.id === lane)!.y;

/** Hand-placed layout: `col`/`row` are grid cells inside the lane band. */
function node(
  id: string,
  label: string,
  kind: NodeKind,
  lane: Lane,
  col: number,
  row: number,
  codeRef: string,
  summary: string,
  adr?: string,
): FlowNode {
  const n: FlowNode = { id, label, kind, lane, x: X0 + col * COL, y: laneY(lane) + row * ROW, codeRef, summary };
  if (adr) n.adr = adr;
  return n;
}

export const NODES: readonly FlowNode[] = [
  // plan
  node("plan.goal", "Goal + interactive plan", "stage", "plan", 0, 0, "src/tasks/planner.ts#runPlanner", "The lead brainstorms with the human and writes tickets.json plus a plan brief.", "ADR-0010"),
  node("plan.gate", "Plan gate", "decision", "plan", 1, 0, "src/commands/plan-pipeline.ts#planGate", "The single human gate: ask on a TTY, run with --yes, otherwise print a hint.", "ADR-0010"),
  node("plan.hint", "Print commands (hint)", "terminal", "plan", 1, 1, "src/commands/plan-pipeline.ts#planGate", "No TTY and no --yes: print the create/route/autopilot commands and stop."),
  node("plan.resolve", "Resolve plan", "decision", "plan", 2, 0, "src/tasks/plan.ts#resolvePlan", "The single validator: errors block creation, warnings are advisory."),
  node("plan.blocked", "Blocked by plan errors", "terminal", "plan", 2, 1, "src/tasks/plan.ts#resolvePlan", "Missing title or duplicate id: nothing is created."),
  node("plan.reuse", "Marker reuse?", "decision", "plan", 3, 0, "src/tasks/plan-create.ts#createFromPlan", "Deterministic plan/ticket markers reuse issues from earlier passes, including closed ones."),
  node("plan.create", "Create issues", "stage", "plan", 4, 0, "src/tasks/plan-create.ts#createFromPlan", "Creates missing issues with routing labels and the plan brief; re-lists after any error."),
  // route
  node("route.assign", "Routing brief", "stage", "route", 0, 0, "src/commands/assign.ts#autoRoute", "Whole-open-graph brief for issues missing agent: and effort: labels."),
  node("route.judge", "Lead judge", "stage", "route", 1, 0, "src/routing/judge.ts#runJudge", "The lead runs headless and returns a routing plan.", "ADR-0005"),
  node("route.eval", "Plan contract-valid?", "decision", "route", 2, 0, "src/routing/judge-eval.ts#evaluatePlan", "Coverage, duplicates, agent/effort validity and rationale checks.", "ADR-0005"),
  node("route.apply", "Apply (fill blanks)", "stage", "route", 3, 0, "src/routing/assign.ts#applyPlan", "Writes labels only where agent:/effort: are missing; never replaces existing ones."),
  node("route.eligible", "Eligible issues", "decision", "route", 0, 1, "src/board/board.ts#eligibleIssues", "status:todo, no open Depends-on blockers, owned by the asking agent."),
  node("route.cycles", "Dependency graph", "decision", "route", 1, 1, "src/board/graph.ts#buildGraph", "Pure DAG over open issues; cycles are reported, never auto-broken."),
  node("route.after", "After: ordering", "stage", "route", 2, 1, "src/board/board.ts#orderByAfter", "Advisory preference among eligible candidates; falls back to issue number."),
  node("route.cycle-deadlock", "Deadlock reported", "terminal", "route", 1, 2, "src/commands/cycle-report.ts#reportCycles", "Every remaining task sits in a cycle: name it and wait for a human."),
  // claim / run
  node("state.ready", "ready", "state", "run", 0, 1, "src/tasks/lifecycle.ts#deriveTaskState", "Open, status:todo, no lock or worktree."),
  node("run.claim", "Claim next", "stage", "run", 0, 0, "src/tasks/service.ts#claimNext", "Picks the lowest-preference eligible task for the agent."),
  node("run.saga", "Claim saga", "decision", "run", 1, 0, "src/tasks/service.ts#claimSpecific", "Git lock ref, GitHub projection and worktree, each re-observed before rolling forward.", "ADR-0002"),
  node("run.compensate", "Compensate", "stage", "run", 1, 1, "src/tasks/service.ts#claimSpecific", "Restores only the saga's field delta and compare-deletes its own lock."),
  node("state.claimed", "claimed", "state", "run", 2, 0, "src/tasks/lifecycle.ts#deriveTaskState", "Lock held and worktree registered; harness not started."),
  node("state.in-progress", "in-progress", "state", "run", 3, 0, "src/tasks/lifecycle.ts#deriveTaskState", "The harness is working in the worktree.", "ADR-0006"),
  node("run.outcome", "Run outcome", "decision", "run", 4, 0, "src/tasks/runner.ts#processNext", "processClaimed classifies the finished run from exit code, commits and its own log range."),
  node("run.submit", "Submit", "stage", "run", 5, 0, "src/tasks/service.ts#submit", "Pushes the branch, opens the PR, labels it review:needed."),
  node("run.fail", "Run failed", "stage", "run", 4, 1, "src/tasks/runner.ts#processNext", "Non-zero exit: safe cleanup, then needs-attention."),
  node("run.nocommit", "No commits", "stage", "run", 5, 1, "src/tasks/runner.ts#processNext", "The harness exited cleanly but produced nothing to submit."),
  node("run.usage", "Usage limit?", "decision", "run", 3, 1, "src/adapters/usage-limit.ts#detectUsageLimit", "Only error-shaped events in this run's own log count, never assistant text.", "ADR-0008"),
  node("run.requeue", "Requeue", "stage", "run", 2, 1, "src/tasks/runner.ts#requeueClaim", "Safe cleanup, release the lock, back to status:todo and pause the harness.", "ADR-0008"),
  // review
  node("state.in-review", "in-review", "state", "review", 0, 0, "src/tasks/lifecycle.ts#deriveTaskState", "Open PR carrying review:needed."),
  node("review.pick", "Pick reviewer", "decision", "review", 1, 0, "src/board/reviewer.ts#pickReviewer", "Prefer any available other harness; the author only when all others are paused.", "ADR-0008"),
  node("review.cross", "Cross-review", "stage", "review", 2, 0, "src/board/review-run.ts#runAutomatedReview", "The other harness reviews in a read-only checkout of exactly the PR head.", "ADR-0003"),
  node("review.self", "Self-review", "stage", "review", 2, 1, "src/board/review-run.ts#runAutomatedReview", "A fresh author session, recorded as a marked mode:self approval.", "ADR-0008"),
  node("review.run", "Reviewer verdict run", "stage", "review", 3, 0, "src/board/review-run.ts#runAutomatedReview", "Headless read-only run bound to the head it read."),
  node("review.verdict", "Verdict", "decision", "review", 4, 0, "src/board/review-run.ts#parseVerdict", "A fenced-JSON verdict is required; anything else fails closed."),
  node("review.approve", "Record approval", "stage", "review", 5, 0, "src/board/review.ts#approve", "Head-bound COMMENT review carrying the approval marker.", "ADR-0003"),
  node("review.changes", "Request changes", "stage", "review", 4, 1, "src/board/review.ts#requestChanges", "Revokes earlier approvals and bounces the PR to the author."),
  node("review.failclosed", "Fail closed", "terminal", "review", 5, 1, "src/board/review-run.ts#parseVerdict", "Unreadable verdict or missing diff: nothing is recorded."),
  node("review.gate", "Merge gate", "decision", "review", 6, 0, "src/board/review.ts#checkMergeGate", "Accepted approval on the current head; labels never authorize a merge."),
  node("review.merge", "Merge", "stage", "review", 7, 0, "src/board/review.ts#merge", "REST SHA-guarded merge; releases the claim lock and cleans up safely."),
  node("state.done", "done", "state", "review", 8, 0, "src/tasks/lifecycle.ts#deriveTaskState", "Merged and closed."),
  // autopilot
  node("auto.observe", "Observe PRs", "stage", "autopilot", 0, 0, "src/tasks/observe.ts#observeTasks", "Re-derives reviews, CI and mergeability from GitHub; skips what it cannot read.", "ADR-0009"),
  node("auto.decide", "Decide step", "decision", "autopilot", 1, 0, "src/tasks/steps.ts#decideStep", "Pure map from observed PR facts to exactly one step.", "ADR-0009"),
  node("step.none", "none", "terminal", "autopilot", 2, 0, "src/tasks/steps.ts#decideStep", "needs-attention or no open PR: nothing for the loop to do."),
  node("step.review", "review", "stage", "autopilot", 3, 0, "src/board/review-run.ts#runAutomatedReview", "No accepted approval on the current head."),
  node("step.fix", "fix", "stage", "autopilot", 4, 0, "src/tasks/step-exec.ts#executeFix", "Resumes the author's session for review feedback or failing CI.", "ADR-0009"),
  node("step.resolve-conflict", "resolve-conflict", "stage", "autopilot", 5, 0, "src/tasks/step-exec.ts#executeResolveConflict", "Merges origin/<base> (never rebase) and verifies the ancestor before pushing.", "ADR-0009"),
  node("auto.push", "Push + requeue review", "stage", "autopilot", 6, 0, "src/tasks/step-exec.ts#executeFix", "Orch pushes HEAD to the task branch, never forced, then restores review:needed."),
  node("step.wait", "wait", "stage", "autopilot", 2, 1, "src/tasks/steps.ts#decideStep", "CI pending or mergeability unknown; also a paused harness."),
  node("step.await-human", "await-human", "terminal", "autopilot", 3, 1, "src/tasks/steps.ts#decideStep", "Approved and green but requireHumanMerge is on."),
  node("step.merge", "merge", "stage", "autopilot", 4, 1, "src/board/review.ts#merge", "Approved and green; always goes through the merge gate."),
  node("step.triage", "triage", "stage", "autopilot", 5, 1, "src/tasks/step-exec.ts#executeTriage", "Round budget spent: the lead decides retry or escalate.", "ADR-0010"),
  node("step.escalate", "escalate", "stage", "autopilot", 6, 1, "src/tasks/step-exec.ts#executeEscalate", "Labels needs-attention and comments why; the loop then ignores the task.", "ADR-0009"),
  node("auto.report", "Run report", "terminal", "autopilot", 1, 1, "src/board/report.ts#buildRunReport", "Escalation rate, rounds to approval and cost per merged task.", "ADR-0009"),
  // recovery
  node("state.needs-attention", "needs-attention", "state", "recovery", 0, 0, "src/tasks/lifecycle.ts#deriveTaskState", "A failed or empty run, closed PR or orphaned work awaits a human.", "ADR-0006"),
  node("rec.repair", "orch repair", "stage", "recovery", 1, 0, "src/tasks/reconcile.ts#reconcileIssue", "Read-only by default; --apply runs one idempotent action then re-observes.", "ADR-0006"),
  node("rec.derive", "Derive state", "decision", "recovery", 2, 0, "src/tasks/lifecycle.ts#deriveTaskState", "Pure authority over observed issue, lock, worktree, branch, PR and telemetry facts.", "ADR-0006"),
  node("state.inconsistent", "inconsistent", "state", "recovery", 3, 0, "src/tasks/lifecycle.ts#decideTaskTransition", "Contradictory facts; every violation is repaired before transitioning.", "ADR-0006"),
  node("rec.abandon", "orch abandon", "stage", "recovery", 0, 1, "src/commands/abandon.ts#abandonCommand", "Releases a task back to todo.", "ADR-0006"),
  node("rec.safe", "Safe to remove?", "decision", "recovery", 1, 1, "src/git/worktree.ts#worktreeRemovalSafety", "Only disposable ignored paths may be lost; anything else keeps the worktree."),
  node("rec.retained", "Retained + named", "terminal", "recovery", 2, 1, "src/git/worktree.ts#worktreeRemovalSafety", "Worktree and lock are kept, with the reason reported."),
  node("rec.discard", "--discard", "stage", "recovery", 1, 2, "src/commands/abandon.ts#abandonCommand", "The only force-removal path; human-explicit.", "ADR-0006"),
];

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function edge(from: string, to: string, label: string, ...flows: FlowId[]): FlowEdge {
  return { id: `${from}>${to}:${slug(label)}`, from, to, label, flows };
}

export const EDGES: readonly FlowEdge[] = [
  // plan-pipeline
  edge("plan.goal", "plan.gate", "tickets.json written", "plan-pipeline"),
  edge("plan.gate", "plan.hint", "no TTY, no --yes: hint", "plan-pipeline"),
  edge("plan.gate", "plan.resolve", "ask (y) or --yes: run", "plan-pipeline"),
  edge("plan.resolve", "plan.blocked", "errors block", "plan-pipeline"),
  edge("plan.resolve", "plan.reuse", "valid (warnings advisory)", "plan-pipeline"),
  edge("plan.reuse", "plan.create", "no marker: create", "plan-pipeline"),
  edge("plan.create", "plan.reuse", "create error: re-list", "plan-pipeline"),
  edge("plan.reuse", "route.assign", "marker found: reuse issue", "plan-pipeline"),
  edge("plan.create", "route.assign", "created: route them", "plan-pipeline"),
  // routing
  edge("route.assign", "route.judge", "brief to the lead", "routing"),
  edge("route.judge", "route.eval", "routing plan JSON", "routing"),
  edge("route.eval", "route.apply", "valid (gaps warn on stderr)", "routing"),
  edge("route.apply", "state.ready", "agent:/effort: filled", "routing"),
  // eligibility, cycles, ordering
  edge("state.ready", "route.eligible", "next / run / autopilot", "claim-run"),
  edge("route.eligible", "route.cycles", "open dependencies", "dependency-cycle"),
  edge("route.cycles", "route.cycle-deadlock", "cycle and none eligible", "dependency-cycle"),
  edge("route.cycles", "route.after", "eligible set", "advisory-order"),
  edge("route.after", "run.claim", "lowest preference first", "advisory-order", "claim-run"),
  // claim saga
  edge("run.claim", "run.saga", "lock + projection + worktree", "claim-run"),
  edge("run.saga", "state.claimed", "setup verified", "claim-run"),
  edge("run.saga", "run.compensate", "step failed", "claim-run"),
  edge("run.compensate", "state.ready", "delta restored, own lock deleted", "claim-run"),
  edge("state.claimed", "state.in-progress", "start-work", "claim-run"),
  edge("state.in-progress", "run.outcome", "harness exits", "claim-run"),
  // processClaimed outcomes
  edge("run.outcome", "run.submit", "commits made", "claim-run"),
  edge("run.submit", "state.in-review", "PR opened", "claim-run"),
  edge("run.outcome", "run.fail", "non-zero exit", "failure-recovery"),
  edge("run.outcome", "run.nocommit", "no commits", "failure-recovery"),
  edge("run.fail", "state.needs-attention", "failed run", "failure-recovery"),
  edge("run.nocommit", "state.needs-attention", "nothing to submit", "failure-recovery"),
  edge("run.fail", "rec.safe", "safe cleanup", "failure-recovery"),
  edge("run.outcome", "run.usage", "own log shows a limit", "usage-limit"),
  edge("run.usage", "run.requeue", "cleanup removed worktree", "usage-limit"),
  edge("run.usage", "run.fail", "worktree retained: failed path", "usage-limit", "failure-recovery"),
  edge("run.requeue", "state.ready", "status:todo, harness paused", "usage-limit"),
  edge("run.requeue", "step.wait", "autopilot: agent.unavailable", "usage-limit"),
  // review
  edge("state.in-review", "review.pick", "review:needed", "cross-review"),
  edge("review.pick", "review.cross", "other harness available", "cross-review"),
  edge("review.pick", "review.self", "all others paused (cross-or-self)", "self-review"),
  edge("review.cross", "review.run", "read-only checkout of the head", "cross-review"),
  edge("review.self", "review.run", "fresh session, mode:self", "self-review"),
  edge("review.run", "review.verdict", "reply parsed", "cross-review"),
  edge("review.verdict", "review.approve", "approve", "cross-review", "self-review"),
  edge("review.verdict", "review.changes", "changes", "cross-review"),
  edge("review.verdict", "review.failclosed", "unreadable or no diff", "cross-review"),
  edge("review.changes", "state.in-progress", "author bounce", "cross-review"),
  edge("review.failclosed", "state.in-review", "nothing recorded", "cross-review"),
  edge("review.approve", "review.gate", "approval on current head", "cross-review"),
  edge("review.gate", "review.merge", "gate passes", "cross-review"),
  edge("review.gate", "state.in-review", "stale head or no accepted approval", "cross-review"),
  edge("review.merge", "state.done", "merged, lock released", "cross-review"),
  // autopilot
  edge("state.in-review", "auto.observe", "autopilot polls open PRs", "autopilot-fix"),
  edge("auto.observe", "auto.decide", "observed facts", "autopilot-fix"),
  edge("auto.decide", "step.none", "needs-attention or no PR", "autopilot-fix"),
  edge("auto.decide", "step.review", "no accepted approval", "autopilot-fix", "cross-review"),
  edge("step.review", "review.pick", "runs the reviewer", "cross-review"),
  edge("auto.decide", "step.fix", "changes requested", "autopilot-fix"),
  edge("auto.decide", "step.fix", "CI failing", "ci-fix"),
  edge("step.fix", "auto.push", "agent fixed, orch pushes", "autopilot-fix", "ci-fix"),
  edge("auto.decide", "step.resolve-conflict", "branch conflicts with base", "conflict"),
  edge("step.resolve-conflict", "auto.push", "base merged, ancestor verified", "conflict"),
  edge("auto.push", "state.in-review", "review:needed restored", "autopilot-fix", "ci-fix", "conflict", "triage"),
  edge("auto.decide", "step.wait", "CI pending or mergeability unknown", "autopilot-fix"),
  edge("step.wait", "auto.observe", "poll again", "autopilot-fix"),
  edge("auto.decide", "step.merge", "approved and green", "autopilot-fix"),
  edge("auto.decide", "step.await-human", "requireHumanMerge", "autopilot-fix"),
  edge("step.await-human", "review.gate", "human runs orch merge", "autopilot-fix"),
  edge("step.merge", "review.gate", "always through the gate", "autopilot-fix"),
  edge("auto.decide", "step.triage", "budget spent, triages left", "triage"),
  edge("step.triage", "auto.push", "retry: one extra round", "triage"),
  edge("step.triage", "step.escalate", "escalate, paused, failed or unparseable", "triage", "escalation"),
  edge("auto.decide", "step.escalate", "budget spent, triage off", "escalation"),
  edge("step.escalate", "state.needs-attention", "label + PR comment", "escalation"),
  edge("auto.decide", "auto.report", "drained or plan-complete", "report"),
  // recovery
  edge("state.needs-attention", "rec.repair", "human runs orch repair", "repair", "failure-recovery"),
  edge("rec.repair", "rec.derive", "observe facts", "repair"),
  edge("rec.derive", "state.ready", "converged: reset for retry", "repair"),
  edge("rec.derive", "state.inconsistent", "invariant violated", "repair"),
  edge("state.inconsistent", "rec.repair", "--apply one action, re-observe", "repair"),
  edge("state.needs-attention", "rec.abandon", "orch abandon <n>", "abandon"),
  edge("rec.abandon", "rec.safe", "plain abandon: safe removal", "abandon"),
  edge("rec.safe", "state.ready", "clean: removed, lock released", "abandon"),
  edge("rec.safe", "rec.retained", "dirty or untracked: retained", "abandon", "failure-recovery"),
  edge("rec.abandon", "rec.discard", "--discard (human explicit)", "abandon"),
  edge("rec.discard", "state.ready", "force removed", "abandon"),
];

export const FLOWS: readonly FlowDef[] = [
  { id: "plan-pipeline", title: "Plan to issues", summary: "Interactive plan, the single human gate, validation, deterministic marker reuse and creation.", adr: "ADR-0010" },
  { id: "routing", title: "Routing", summary: "The lead judge routes unrouted issues; assign only fills blanks.", adr: "ADR-0005" },
  { id: "claim-run", title: "Claim and run", summary: "Eligibility, the atomic claim saga with compensation, and the processClaimed outcomes.", adr: "ADR-0002" },
  { id: "cross-review", title: "Cross-review and merge", summary: "The other harness reviews the exact head; verdicts are head-bound and the merge gate is the only way in.", adr: "ADR-0003" },
  { id: "autopilot-fix", title: "Autopilot loop", summary: "Observe, decide one step, execute, re-observe: review feedback, waiting, merge.", adr: "ADR-0009" },
  { id: "ci-fix", title: "CI fix", summary: "A failing check resumes the author's session for a fix round.", adr: "ADR-0009" },
  { id: "conflict", title: "Conflict resolution", summary: "A branch that conflicts with base gets the base merged in, never rebased.", adr: "ADR-0009" },
  { id: "triage", title: "Lead triage", summary: "When the round budget is spent the lead decides retry or escalate.", adr: "ADR-0010" },
  { id: "escalation", title: "Escalation", summary: "A stuck task is labelled needs-attention with an explanatory comment.", adr: "ADR-0009" },
  { id: "usage-limit", title: "Usage limit", summary: "A run that hit a harness limit is requeued and the harness waited out, not failed.", adr: "ADR-0008" },
  { id: "self-review", title: "Self-review fallback", summary: "When every other harness is paused, the author's fresh session may review under cross-or-self.", adr: "ADR-0008" },
  { id: "failure-recovery", title: "Failure recovery", summary: "Failed and empty runs clean up safely and keep anything unproven.", adr: "ADR-0006" },
  { id: "repair", title: "Repair", summary: "Observe facts, derive state and apply one idempotent action at a time.", adr: "ADR-0006" },
  { id: "abandon", title: "Abandon", summary: "Safe removal by default; --discard is the only forced path.", adr: "ADR-0006" },
  { id: "dependency-cycle", title: "Dependency cycles", summary: "Cycles in Depends-on are reported, never auto-broken.", adr: "ADR-0009" },
  { id: "advisory-order", title: "Advisory ordering", summary: "After: prefers an order among eligible tasks without ever blocking." },
  { id: "report", title: "Run report", summary: "The loop measures itself and reports at the end of a run.", adr: "ADR-0009" },
];

/** Every autopilot step maps to a node; adding a `Step` kind breaks the build until it does. */
export const STEP_NODES: Record<Step["kind"], string> = {
  none: "step.none",
  review: "step.review",
  fix: "step.fix",
  "resolve-conflict": "step.resolve-conflict",
  merge: "step.merge",
  "await-human": "step.await-human",
  wait: "step.wait",
  triage: "step.triage",
  escalate: "step.escalate",
};

/** Every lifecycle state maps to a node; adding a `TaskStateKind` breaks the build until it does. */
export const STATE_NODES: Record<TaskStateKind, string> = {
  ready: "state.ready",
  claimed: "state.claimed",
  "in-progress": "state.in-progress",
  "in-review": "state.in-review",
  "needs-attention": "state.needs-attention",
  done: "state.done",
  inconsistent: "state.inconsistent",
};
