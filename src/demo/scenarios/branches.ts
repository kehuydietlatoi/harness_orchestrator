// Remaining modeled branches. External outcomes are fixtures; policy outputs
// are recorded from the same pure deciders as the main scenario walks.
import { detectUsageLimit } from "../../adapters/usage-limit.js";
import { parseVerdict } from "../../board/review-run.js";
import { evaluateGate } from "../../board/review.js";
import { pickReviewer } from "../../board/reviewer.js";
import { deriveTaskState, type TaskFacts } from "../../tasks/lifecycle.js";
import { buildPlanMarkers, indexByMarker } from "../../tasks/plan-create.js";
import { decideStep, type StepFacts } from "../../tasks/steps.js";
import { baseTask, decide, ScenarioBuilder, type Scenario } from "../scenario-engine.js";

const N = 98;
const PATH = "../wt/issue-98";
const facts = (over: Partial<TaskFacts> = {}): TaskFacts => ({
  issue: "open", lock: false, worktree: false, branch: "unchanged", pr: "none", telemetry: "none", ...over,
});
const derive = (over: Partial<TaskFacts>) => decide("deriveTaskState", deriveTaskState, facts(over)).decision;
const builder = (id: string, title: string, flows: Scenario["flows"], summary: string) =>
  new ScenarioBuilder({ id, title, flows, summary }, [{ ...baseTask(N), agent: "codex" }]);

const lostCreate = (() => {
  const b = builder("plan-create-response-lost", "Reconcile a lost create response", ["plan-pipeline"],
    "A create error triggers a fresh issue list; finding the deterministic marker prevents a duplicate.");
  const tickets = [{ id: "docs", title: "Document the flows" }];
  const markers = buildPlanMarkers(tickets);
  b.add({ node: "plan.create", narration: "The valid, approved ticket has no existing marker. The create request reaches GitHub, but its response is lost." });
  b.add({ node: "plan.reuse", edge: ["plan.create", "plan.reuse"], narration: "After the create error, re-list issues before considering another create." });
  const issues = [{ number: N, title: tickets[0]!.title, body: markers.tickets[0]!, labels: [], assignees: [], state: "OPEN" as const }];
  const found = decide("indexByMarker", (input: { markers: string[]; issues: typeof issues }) =>
    Object.fromEntries([...indexByMarker(input.issues, input.markers)].map(([marker, matches]) => [marker, matches.map((issue) => issue.number)])),
  { markers: markers.tickets, issues });
  b.patch(N, { title: tickets[0]!.title, agent: null });
  b.add({ node: "route.assign", edge: ["plan.reuse", "route.assign"], decision: found.decision, narration: "The marker resolves to the created issue. Reuse it unchanged rather than repeating the ambiguous write." });
  return b.build();
})();

function compensation(retained: boolean): Scenario {
  const b = builder(`claim-${retained ? "retain" : "roll-forward"}`, retained ? "Claim compensation preserves ownership" : "Ambiguous claim rolls forward", ["claim-run", "failure-recovery"],
    "Claim setup re-observes durable facts before compensating or accepting an ambiguous write.");
  b.patch(N, { status: "status:claimed", locked: true, worktree: PATH });
  b.add({ node: "run.compensate", narration: "A setup write lost its response. Re-observe this attempt's owner token, projection, and worktree registration." });
  if (retained) {
    b.add({ node: "rec.retained", edge: ["run.compensate", "rec.retained"], narration: "The worktree cannot be verified on the expected branch. Preserve both the worktree and lock for reconciliation instead of undoing another owner's work." });
  } else {
    b.add({ node: "state.claimed", edge: ["run.compensate", "state.claimed"], decision: derive({ lock: true, worktree: true }), narration: "The exact owner token, expected projection, and usable task worktree are proven. The claim can roll forward." });
  }
  return b.build();
}

const failedReview = (() => {
  const b = builder("review-unreadable-verdict", "Unreadable review fails closed", ["cross-review"], "An unreadable reviewer response records no approval or change request.");
  b.patch(N, { status: "status:in-review", locked: true, worktree: PATH, prNumber: 198 });
  b.add({ node: "state.in-review", decision: derive({ lock: true, worktree: true, branch: "ahead", pr: "open" }), narration: "The submitted PR awaits a head-bound review." });
  b.add({ node: "review.pick", edge: ["state.in-review", "review.pick"], narration: "Choose an available reviewer." });
  const picked = decide("pickReviewer", (input: { author: string; agents: string[]; policy: "cross"; unavailable: string[] }) =>
    pickReviewer({ ...input, unavailable: new Set(input.unavailable) }), { author: "codex", agents: ["claude", "codex"], policy: "cross", unavailable: [] });
  b.add({ node: "review.cross", edge: ["review.pick", "review.cross"], decision: picked.decision, narration: "claude is available for cross-review." });
  b.add({ node: "review.run", edge: ["review.cross", "review.run"], narration: "A read-only checkout contains the exact PR head and full diff." });
  b.add({ node: "review.verdict", edge: ["review.run", "review.verdict"], narration: "The harness exits without a fenced JSON verdict." });
  b.add({ node: "review.failclosed", edge: ["review.verdict", "review.failclosed"], decision: decide("parseVerdict", parseVerdict, "No structured verdict returned.").decision, narration: "parseVerdict returns null; fail closed." });
  b.add({ node: "state.in-review", edge: ["review.failclosed", "state.in-review"], decision: derive({ lock: true, worktree: true, branch: "ahead", pr: "open" }), narration: "No review was recorded. The PR remains in review." });
  return b.build();
})();

const retainedMerge = (() => {
  const b = builder("merge-worktree-retained", "Merge retains untracked work", ["cross-review", "failure-recovery"], "A successful merge releases the lock, but safe cleanup preserves untracked files.");
  b.patch(N, { status: "status:in-review", locked: true, worktree: PATH, prNumber: 198, reviewedBy: ["claude"] });
  b.add({ node: "review.merge", narration: "The current head passed the merge gate and the SHA-guarded merge succeeded." });
  b.patch(N, { locked: false });
  b.add({ node: "review.cleanup", edge: ["review.merge", "review.cleanup"], narration: "Release the lock after merge. Untracked notes.md prevents safe worktree removal." });
  b.patch(N, { status: "status:inconsistent" });
  b.add({ node: "state.inconsistent", edge: ["review.cleanup", "state.inconsistent"], decision: derive({ issue: "closed", pr: "merged", worktree: true, branch: "ahead" }), narration: "A closed issue with a retained worktree violates lifecycle invariants. Report the retained files for repair." });
  return b.build();
})();

function usage(retained: boolean): Scenario {
  const b = builder(`usage-limit-${retained ? "retained" : "wait"}`, retained ? "Usage limit with retained work" : "Autopilot waits out a usage limit", ["usage-limit", "failure-recovery"],
    "Cooldown is separate from lifecycle: only safe cleanup permits requeue, and the coordinator waits for availability.");
  b.patch(N, { status: "status:in-progress", locked: true, worktree: PATH });
  b.add({ node: "run.outcome", narration: "An unsuccessful run's own appended log contains an error-shaped usage limit." });
  const input = { log: JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1767229200 } }), now: "2026-01-01T00:00:00.000Z" };
  b.add({ node: "run.usage", edge: ["run.outcome", "run.usage"], decision: decide("detectUsageLimit", (i: typeof input) => detectUsageLimit(i.log, new Date(i.now)), input).decision, narration: "Recognize the error event and record a harness cooldown." });
  if (retained) {
    b.add({ node: "run.fail", edge: ["run.usage", "run.fail"], narration: "Untracked files prevent safe worktree removal. Requeue is refused and recovery follows the failed-run path, preserving ownership." });
    b.add({ node: "run.cleanup", edge: ["run.fail", "run.cleanup"], narration: "Safe cleanup keeps the worktree and its lock." });
    b.patch(N, { status: "status:inconsistent" });
    b.add({ node: "state.inconsistent", edge: ["run.cleanup", "state.inconsistent"], decision: derive({ lock: true, worktree: true, telemetry: "failed" }), narration: "Failure telemetry and retained resources require reconciliation." });
  } else {
    b.patch(N, { status: "status:todo", locked: false, worktree: null });
    b.add({ node: "run.requeue", edge: ["run.usage", "run.requeue"], narration: "No commits or open PR; safe removal and lock release succeed. Requeue writes todo and usage-limited telemetry." });
    b.add({ node: "step.wait", edge: ["run.requeue", "step.wait"], narration: "The implementation returns agent.unavailable to autopilot. Wait out the cooldown without treating it as failure or progress." });
  }
  return b.build();
}

function repairProjection(kind: "in-review" | "inconsistent" | "needs-attention"): Scenario {
  const b = builder(`repair-project-${kind}`, `Repair projects ${kind}`, ["repair", "failure-recovery"], "Repair projects observed lifecycle facts; preserving work or a closed PR can leave human recovery necessary.");
  b.patch(N, { status: "needs-attention" });
  b.add({ node: "state.needs-attention", decision: derive({ telemetry: "failed" }), narration: "The last unresolved run requires human inspection. The human invokes repair." });
  b.add({ node: "rec.repair", edge: ["state.needs-attention", "rec.repair"], narration: "Repair observes GitHub, lock, branch, and worktree facts; this scenario fakes only those I/O observations." });
  b.add({ node: "rec.derive", edge: ["rec.repair", "rec.derive"], narration: "Re-observe after any safe repair actions. No branch reset or forced removal is permitted." });
  const observed: Partial<TaskFacts> = kind === "in-review" ? { lock: true, worktree: true, branch: "ahead", pr: "open" }
    : kind === "inconsistent" ? { worktree: true, branch: "ahead" } : { pr: "closed", branch: "ahead" };
  b.patch(N, { status: kind === "needs-attention" ? kind : `status:${kind}`, locked: observed.lock ?? false, worktree: observed.worktree ? PATH : null, prNumber: kind === "in-review" ? 198 : null });
  b.add({ node: `state.${kind}`, edge: ["rec.derive", `state.${kind}`], decision: derive(observed), narration: kind === "in-review" ? "The open PR and protected worktree derive in-review; restore its review projection."
    : kind === "inconsistent" ? "Unverified retained work has no lock. Preserve it and report the invariant violation for reconciliation." : "The PR is still closed without merge and work remains ahead. A human must decide how to recover." });
  return b.build();
}

const abandonReady = (() => {
  const b = builder("abandon-ready", "Abandon returns an unused claim to ready", ["abandon"], "A safely removed claim with no commits or unresolved failure is ready to claim again.");
  b.patch(N, { status: "status:claimed", locked: true, worktree: PATH });
  b.add({ node: "rec.abandon", narration: "The human abandons an unused claim; its task branch has no commits ahead and no unresolved failure telemetry." });
  b.add({ node: "rec.safe", edge: ["rec.abandon", "rec.safe"], narration: "The registered worktree is clean, attached, and safely removable." });
  b.patch(N, { status: "status:todo", agent: null, locked: false, worktree: null });
  b.add({ node: "rec.todo", edge: ["rec.safe", "rec.todo"], narration: "Remove the worktree, release the lock, and project todo." });
  b.add({ node: "state.ready", edge: ["rec.todo", "state.ready"], decision: derive({}), narration: "No failure telemetry or commits ahead survive: the durable facts derive ready." });
  return b.build();
})();

const idle = (() => {
  const b = builder("autopilot-human-owned", "Autopilot skips human-owned tasks", ["autopilot-fix"], "needs-attention causes decideStep to drive no action.");
  b.patch(N, { status: "needs-attention" });
  b.add({ node: "auto.decide", narration: "Observation finds a PR whose issue is marked needs-attention." });
  const input: StepFacts = { attention: true, pr: { number: 198, head: "a".repeat(40), checks: "pass", mergeable: "clean" }, review: { approved: false, changesRequested: true }, rounds: 0, maxRounds: 3, requireHumanMerge: false };
  b.add({ node: "step.none", edge: ["auto.decide", "step.none"], decision: decide("decideStep", decideStep, input).decision, narration: "Human ownership wins over a change request: no automated action." });
  return b.build();
})();

const humanMerge = (() => {
  const b = builder("human-runs-merge", "Human opens the merge gate", ["autopilot-fix"], "A human invokes orch merge after an approved green PR reaches await-human.");
  b.patch(N, { status: "status:in-review", prNumber: 198, reviewedBy: ["claude"], locked: true, worktree: PATH });
  b.add({ node: "step.await-human", narration: "Autopilot found an approved green PR with requireHumanMerge enabled and awaits the human." });
  b.add({ node: "review.gate", edge: ["step.await-human", "review.gate"], narration: "The human invokes orch merge; the command freshly checks the head-bound approval and CI." });
  const gate = { author: "codex", reviewers: ["claude"], agents: ["claude", "codex"], requireCrossReview: true, checksPass: true, checksDetail: "passed", requireHumanMerge: true, humanApproved: true };
  b.add({ node: "review.merge", edge: ["review.gate", "review.merge"], decision: decide("evaluateGate", evaluateGate, gate).decision, narration: "Human approval plus the existing policy checks permit the SHA-guarded merge." });
  return b.build();
})();

export const BRANCH_SCENARIOS: readonly Scenario[] = [
  lostCreate, compensation(false), compensation(true), failedReview, retainedMerge,
  usage(false), usage(true), repairProjection("in-review"), repairProjection("inconsistent"),
  repairProjection("needs-attention"), abandonReady, idle, humanMerge,
];
