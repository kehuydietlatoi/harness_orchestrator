// Recovery walks fake observations and writes only; all policy decisions use production code.
import { detectUsageLimit } from "../../adapters/usage-limit.js";
import { acceptedReviewers, formatReview, reviewState } from "../../board/approval.js";
import { byNumber, openDepsFromMap, orderByAfter, parseAfter, parseDeps } from "../../board/board.js";
import { buildGraph } from "../../board/graph.js";
import { pickReviewer } from "../../board/reviewer.js";
import { parseVerdict } from "../../board/review-run.js";
import type { ReviewPolicy } from "../../config.js";
import type { Issue } from "../../github/github.js";
import { telemetryFact } from "../../tasks/facts.js";
import { decideTaskTransition, deriveTaskState, type TaskFacts } from "../../tasks/lifecycle.js";
import { planRepairs, type RepairAction, type RepairObservation } from "../../tasks/reconcile.js";
import { baseTask, decide, ScenarioBuilder, type Scenario } from "../scenario-engine.js";

const N = 71;
const PATH = "../wt/issue-71";
const HEAD = "a".repeat(40);
const TS = "2026-01-01T00:00:00.000Z";
const facts = (over: Partial<TaskFacts> = {}): TaskFacts => ({
  issue: "open", lock: false, worktree: false, branch: "unchanged", pr: "none", telemetry: "none", ...over,
});
const issue = (number: number, body = "", labels = ["status:todo", "agent:codex"]): Issue => ({
  number, title: `Task #${number}`, body, labels, assignees: [], state: "OPEN",
});
const builder = (id: string, title: string, flows: Scenario["flows"], summary: string) =>
  new ScenarioBuilder({ id, title, flows, summary }, [{ ...baseTask(N), agent: "codex" }]);
const derive = (f: TaskFacts) => decide("deriveTaskState", deriveTaskState, f).decision;

function failedRun(kind: "failed" | "timeout" | "no-commits", retained = false): Scenario {
  const b = builder(`run-${kind}${retained ? "-retained" : ""}`, `Run: ${kind}${retained ? ", work retained" : ""}`,
    ["failure-recovery"], "Failed and empty runs clean up safely; retained work keeps ownership and requires reconciliation.");
  b.patch(N, { status: "status:in-progress", locked: true, worktree: PATH });
  b.add({ node: "state.in-progress", decision: derive(facts({ lock: true, worktree: true, branch: "ahead" })), narration: "The harness is working under its claim lock." });
  b.add({ node: "run.outcome", edge: ["state.in-progress", "run.outcome"], narration: kind === "timeout" ? "The run times out; the process tree is terminated and the run fails." : `The harness exits: ${kind}.` });
  const to = kind === "no-commits" ? "run.nocommit" : "run.fail";
  const transition = decide("decideTaskTransition", (i: { from: "in-progress"; event: "run-failed" }) => decideTaskTransition(i.from, i.event), { from: "in-progress", event: "run-failed" });
  b.add({ node: to, edge: ["run.outcome", to], decision: transition.decision, narration: "The run-failed transition calls for needs-attention, subject to the observed cleanup facts." });
  b.add({ node: "run.cleanup", edge: [to, "run.cleanup"], narration: retained ? "Faked cleanup observation: untracked notes.md keeps the worktree and lock." : "Faked cleanup observation: clean attached worktree, HEAD preserved elsewhere; safe removal succeeds, then the lock is released." });
  b.patch(N, { status: "needs-attention", locked: retained, worktree: retained ? PATH : null });
  b.add({ node: retained ? "state.inconsistent" : "state.needs-attention", edge: ["run.cleanup", retained ? "state.inconsistent" : "state.needs-attention"],
    decision: derive(facts({ lock: retained, worktree: retained, telemetry: kind === "no-commits" ? kind : "failed" })),
    narration: retained ? "Failure telemetry plus retained resources violates finished-run-requires-released-resources. Repair must preserve the work." : "Released resources plus unresolved failure telemetry derive needs-attention." });
  return b.build();
}

function abandon(mode: "clean" | "retained" | "discard"): Scenario {
  const b = builder(`abandon-${mode}`, `Abandon: ${mode}`, ["abandon"], "Abandon changes labels and resources; failure telemetry and task branches survive.");
  b.patch(N, { status: "needs-attention", locked: true, worktree: PATH });
  b.add({ node: "state.needs-attention", decision: derive(facts({ lock: true, worktree: true, branch: "ahead", pr: "closed" })), narration: "A PR closed without merging leaves unmerged commits and retained resources requiring inspection. The human chooses abandon." });
  b.add({ node: "rec.abandon", edge: ["state.needs-attention", "rec.abandon"], narration: "Abandon observes a retained claim/worktree. The human explicitly chooses whether to discard it." });
  if (mode === "discard") {
    b.add({ node: "rec.discard", edge: ["rec.abandon", "rec.discard"], narration: "orch abandon 71 --discard explicitly force-removes recoverable files; it does not delete the task branch." });
  } else {
    b.add({ node: "rec.safe", edge: ["rec.abandon", "rec.safe"], narration: mode === "clean" ? "Faked safe-removal result: clean, attached, commits preserved by a remote ref." : "Faked safe-removal result: untracked notes.md blocks removal." });
    if (mode === "retained") {
      b.add({ node: "rec.retained", edge: ["rec.safe", "rec.retained"], narration: "notes.md is named in the retention reason. Ownership and projection stay intact; a later human invocation can use abandon --discard." });
      return b.build();
    }
  }
  b.patch(N, { status: "status:todo", agent: null, locked: false, worktree: null });
  b.add({ node: "rec.todo", edge: [mode === "discard" ? "rec.discard" : "rec.safe", "rec.todo"], narration: "Removal succeeded, then the lock is released and routing/attention labels are removed in favor of status:todo." });
  b.add({ node: "state.needs-attention", edge: ["rec.todo", "state.needs-attention"], decision: derive(facts({ branch: "ahead", pr: "closed" })), narration: "The closed PR and unmerged branch still exist: lifecycle remains needs-attention despite the todo label. Abandon also leaves any failure telemetry unresolved." });
  return b.build();
}

const usageLimit = ((): Scenario => {
  const b = builder("usage-limit-requeue", "Usage limit: requeue and cooldown", ["usage-limit"], "Only this run's appended error events can trigger cooldown and safe requeue.");
  // Pass only this run's slice: older appended errors and assistant prose are not the input.
  const logText = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1767229200 } });
  b.patch(N, { agent: "claude", status: "status:in-progress", locked: true, worktree: PATH });
  b.add({ node: "run.outcome", narration: "An unsuccessful run exits. Older log ranges are excluded; only this run's appended slice is inspected." });
  const limit = decide("detectUsageLimit", (i: { logText: string; now: string }) => detectUsageLimit(i.logText, new Date(i.now)), { logText, now: TS });
  b.add({ node: "run.usage", edge: ["run.outcome", "run.usage"], decision: limit.decision, narration: `An error-shaped limit pauses claude until ${limit.output?.resetAt}. Assistant text mentioning limits would not count.` });
  b.patch(N, { status: "status:todo", locked: false, worktree: null });
  b.add({ node: "run.requeue", edge: ["run.usage", "run.requeue"], narration: "Faked I/O confirms no commits ahead, no open PR, safe worktree removal, then lock release. Requeue writes todo without needs-attention; claude stays on cooldown." });
  b.add({ node: "state.ready", edge: ["run.requeue", "state.ready"], decision: derive(facts({ telemetry: telemetryFact([{ issue: N, outcome: "usage-limited" }], N) })), narration: "Usage-limited telemetry is not an unresolved failure: ready. Scheduling waits for the cooldown rather than counting a failure." });
  return b.build();
})();

function selfReview(policy: ReviewPolicy): Scenario {
  const b = builder(`self-review-${policy}`, `Self-review policy: ${policy}`, ["self-review"], "The other harness is paused; only cross-or-self permits a fresh author review.");
  b.patch(N, { status: "status:in-review", locked: true, worktree: PATH, prNumber: 171 });
  const picked = decide("pickReviewer", (i: { author: string; agents: string[]; policy: ReviewPolicy; unavailable: string[] }) => pickReviewer({ ...i, unavailable: new Set(i.unavailable) }),
    { author: "codex", agents: ["claude", "codex"], policy, unavailable: ["claude"] });
  if (!picked.output) {
    // No graph edge represents a refused pick: this scenario stops at that decision.
    b.add({ node: "review.pick", decision: picked.decision, narration: "claude is paused and cross policy forbids self-review: pickReviewer returns null. No review is run or recorded; wait for the other harness." });
    return b.build();
  }
  b.add({ node: "review.pick", narration: "claude is paused; the author codex is available." });
  b.add({ node: "review.self", edge: ["review.pick", "review.self"], decision: picked.decision, narration: "cross-or-self selects codex in mode:self, only because every other harness is paused." });
  b.add({ node: "review.run", edge: ["review.self", "review.run"], narration: "A fresh read-only author session inspects exactly the PR head." });
  b.add({ node: "review.verdict", edge: ["review.run", "review.verdict"], narration: "The fresh session returns a fenced JSON verdict." });
  const verdict = decide("parseVerdict", parseVerdict, '```json\n{"decision":"approve","notes":"Verified the head."}\n```');
  b.add({ node: "review.approve", edge: ["review.verdict", "review.approve"], decision: verdict.decision, narration: "The approval must carry the head-bound mode:self marker." });
  const body = formatReview({ reviewer: "codex", pr: 171, head: HEAD, timestamp: TS, decision: "approve", mode: "self" }, "Fresh-session approval.");
  const state = reviewState([{ id: 1, body, state: "COMMENTED", commit_id: HEAD }], 171, HEAD);
  const accepted = decide("acceptedReviewers", (i: { state: typeof state; author: string; policy: ReviewPolicy }) => acceptedReviewers(i.state, i.author, i.policy), { state, author: "codex", policy });
  b.patch(N, { reviewedBy: accepted.output });
  b.add({ node: "review.gate", edge: ["review.approve", "review.gate"], decision: accepted.decision, narration: "The marked self approval counts under cross-or-self. The identical record is not accepted under cross." });
  return b.build();
}

const compensation = ((): Scenario => {
  const b = builder("claim-compensation", "Ambiguous claim write: compensate", ["claim-run", "failure-recovery"], "Re-observe ambiguous writes; compensate only the saga's own delta and owner token.");
  b.add({ node: "run.claim", narration: "The issue is ready. The claim attempt gets a unique owner token." });
  const claim = decide("decideTaskTransition", () => decideTaskTransition("ready", "claim"), { from: "ready", event: "claim" });
  b.add({ node: "run.saga", edge: ["run.claim", "run.saga"], decision: claim.decision, narration: "Lock acquired. The issue projection write loses its response; re-observation shows only a partial write, so rolling forward is forbidden." });
  b.patch(N, { status: "status:claimed", locked: true });
  b.add({ node: "run.compensate", edge: ["run.saga", "run.compensate"], narration: "Faked observations prove the exact owner token and absent worktree. Compensation restores only this attempt's issue-field delta, verifies status:claimed is gone, then compare-deletes its own lock." });
  b.patch(N, { status: "status:todo", locked: false });
  b.add({ node: "state.ready", edge: ["run.compensate", "state.ready"], decision: derive(facts()), narration: "The compensated observations derive ready. Unverifiable worktree or ownership would have been retained instead." });
  return b.build();
})();

/** Simulated adapter writes, one action at a time; policy remains in planRepairs. */
function applyRepair(o: RepairObservation, a: RepairAction): void {
  switch (a.kind) {
    case "safe-remove-worktree": o.worktree = { kind: "absent" }; break;
    case "release-lock": o.lockOwner = null; break;
    case "acquire-lock": o.lockOwner = "demo-owner"; break;
    case "supersede-telemetry": o.telemetry = "none"; break;
    case "sync-labels": o.issue!.labels = [...o.issue!.labels.filter((l) => !a.remove.includes(l)), ...a.add]; break;
    default: throw new Error(`unexpected recovery demo action: ${a.kind}`);
  }
}

function repair(kind: "ready" | "claimed" | "in-progress" | "done"): Scenario {
  const closed = kind === "done";
  const retry = kind === "ready";
  const o: RepairObservation = { number: N, issue: { ...issue(N, "", ["needs-attention"]), state: closed ? "CLOSED" : "OPEN" }, expectedBranch: "task/71", lockOwner: closed || retry ? "demo-owner" : null,
    worktree: { kind: "usable", path: PATH, branch: "task/71", removable: true }, branch: kind === "in-progress" ? "ahead" : "unchanged", prs: [], reviews: [], telemetry: retry ? "failed" : "none" };
  const observedFacts = (): TaskFacts => facts({ issue: closed ? "closed" : "open", lock: o.lockOwner !== null, worktree: o.worktree.kind === "usable", branch: o.branch, telemetry: o.telemetry });
  const b = builder(`repair-${kind}`, `Repair converges to ${kind}`, ["repair"], "Preview is read-only; apply executes one action then re-observes, until the planner returns no actions.");
  b.patch(N, { status: "needs-attention", locked: o.lockOwner !== null, worktree: PATH });
  b.add({ node: "state.inconsistent", decision: derive(observedFacts()), narration: "Observed resources violate lifecycle invariants. decideTaskTransition refuses transitions until reconciliation." });
  b.add({ node: "rec.repair", edge: ["state.inconsistent", "rec.repair"], narration: "orch repair previews the plan without mutating these observations; --apply is the explicit execution mode." });
  const preview = decide("planRepairs", planRepairs, structuredClone(o));
  b.add({ node: "rec.derive", edge: ["rec.repair", "rec.derive"], decision: preview.decision, narration: `Preview projects ${preview.output.projectedState.kind}: ${preview.output.actions.map((a) => a.kind).join(", ")}.` });
  for (let n = 0; n < 10; n++) {
    const action = planRepairs(o).actions[0];
    if (!action) break;
    applyRepair(o, action);
  }
  const converged = planRepairs(o);
  if (converged.actions.length || converged.blocked.length || converged.state.kind !== kind) throw new Error(`repair demo did not converge: ${kind}`);
  b.patch(N, { status: o.issue!.labels.find((l) => l.startsWith("status:"))!, locked: o.lockOwner !== null, worktree: o.worktree.kind === "usable" ? PATH : null });
  b.add({ node: `state.${kind}`, edge: ["rec.derive", `state.${kind}`], decision: derive(observedFacts()), narration: `--apply executed one action at a time, re-planning after every write. A repeated preview now has zero actions: ${kind}.` });
  return b.build();
}

const cycle = ((): Scenario => {
  const open = [issue(71, "Depends-on: #72"), issue(72, "Depends-on: #71")];
  const b = builder("dependency-deadlock", "Dependency cycle: report only", ["dependency-cycle"], "Both tasks block each other; the cycle is reported without changing either body.");
  for (const i of open) b.patch(i.number, { agent: "codex", deps: parseDeps(i.body) });
  b.add({ node: "route.cycles", narration: "Every open task has an open hard dependency: none is eligible." });
  const graph = decide("buildGraph", buildGraph, open);
  b.add({ node: "route.cycle-deadlock", edge: ["route.cycles", "route.cycle-deadlock"], decision: graph.decision, narration: "buildGraph reports 71 -> 72 -> 71 and an empty topological order. Nothing is auto-broken; a human must change the dependencies." });
  return b.build();
})();

function scheduling(unavailablePredecessor: boolean): Scenario {
  const open = [issue(71, "After: #72"), issue(72, unavailablePredecessor ? "Depends-on: #73" : ""), issue(73, "Depends-on: #72")];
  const eligible = open.filter((i) => openDepsFromMap(i, byNumber(open)).length === 0);
  const b = builder(`after-${unavailablePredecessor ? "unavailable" : "eligible"}`, "After preferences vs hard dependencies", ["advisory-order"], "Order eligible candidates only: After never blocks on an unavailable predecessor, Depends-on does.");
  for (const i of open) b.patch(i.number, { agent: "codex", deps: parseDeps(i.body), after: parseAfter(i.body) });
  b.add({ node: "route.after", narration: unavailablePredecessor ? "#72 and #73 have hard blockers. #71's After: #72 remains advisory, so #71 is eligible." : "#73 depends on open #72 and is blocked; #71 and #72 are eligible. After: #72 prefers #72 first." });
  const ordered = decide("orderByAfter", orderByAfter, eligible);
  b.add({ node: "run.claim", edge: ["route.after", "run.claim"], decision: ordered.decision, narration: `Eligible order: ${ordered.output.map((i) => `#${i.number}`).join(", ")}. Unavailable predecessors never gate work.` });
  return b.build();
}

export const RECOVERY_SCENARIOS: readonly Scenario[] = [
  failedRun("failed"), failedRun("timeout"), failedRun("no-commits"), failedRun("failed", true),
  abandon("clean"), abandon("retained"), abandon("discard"), usageLimit,
  selfReview("cross-or-self"), selfReview("cross"), compensation,
  repair("ready"), repair("claimed"), repair("in-progress"), repair("done"), cycle,
  scheduling(false), scheduling(true),
];
