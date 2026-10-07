// Core scenarios: the plan-to-merge happy path and its branch points. Every decision is a call to the
// real pure decider on faked facts; nothing here touches GitHub, git or an agent.
import { acceptedReviewers, formatReview, reviewState } from "../../board/approval.js";
import { byNumber, claimableBy, openDepsFromMap, orderByAfter } from "../../board/board.js";
import { buildGraph } from "../../board/graph.js";
import { parseVerdict } from "../../board/review-run.js";
import { evaluateGate } from "../../board/review.js";
import { pickReviewer } from "../../board/reviewer.js";
import { planGate } from "../../commands/plan-pipeline.js";
import type { Issue } from "../../github/github.js";
import { evaluatePlan } from "../../routing/judge-eval.js";
import { applyPlan, type PlanEntry } from "../../routing/assign.js";
import { decideTaskTransition, deriveTaskState, type TaskFacts } from "../../tasks/lifecycle.js";
import { buildPlanMarkers, indexByMarker, renderTicketBody } from "../../tasks/plan-create.js";
import { resolvePlan, type Ticket } from "../../tasks/plan.js";
import { decideStep, type StepFacts } from "../../tasks/steps.js";
import { baseTask, decide, ScenarioBuilder, type Scenario } from "../scenario-engine.js";

const AGENTS = ["claude", "codex"];
const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const TS = "2026-01-01T00:00:00.000Z";

const issue = (number: number, labels: string[], body = "", state = "OPEN"): Issue => ({
  number,
  title: `Task #${number}`,
  body,
  state,
  labels,
  assignees: [],
});

const PLAN: Ticket[] = [
  { id: "model", title: "Add the data model", body: "Define the types.", files: ["src/model.ts"], agent: "claude", effort: "easy" },
  { id: "api", title: "Expose it over the API", dependsOn: ["model"], files: ["src/api.ts"] },
];

/** Plan, validate, and stop at the gate: the opening shared by every plan scenario. */
function toGate(b: ScenarioBuilder, tickets: Ticket[]): ReturnType<typeof resolvePlan> {
  b.add({ node: "plan.goal", narration: "The human and the lead brainstorm a goal; the session writes tickets.json and a plan brief." });
  const { decision, output: plan } = decide("resolvePlan", (t: Ticket[]) => resolvePlan(t, { agents: AGENTS }), tickets);
  b.add({
    node: "plan.resolve",
    edge: ["plan.goal", "plan.resolve"],
    narration: `orch validates the ${tickets.length} tickets before asking anyone to approve them.`,
  });
  if (plan.errors.length) {
    b.add({
      node: "plan.blocked",
      edge: ["plan.resolve", "plan.blocked"],
      decision,
      narration: `resolvePlan reports ${plan.errors.length} blocking error(s): ${plan.errors.join("; ")}. Nothing is created.`,
    });
  } else {
    b.add({
      node: "plan.gate",
      edge: ["plan.resolve", "plan.gate"],
      decision,
      narration: plan.warnings.length
        ? `No errors. ${plan.warnings.length} advisory warning(s) (${plan.warnings.join("; ")}) are shown but never block.`
        : "The plan is valid and previewed. The single human gate comes next.",
    });
  }
  return plan;
}

function gateScenario(
  id: string,
  title: string,
  summary: string,
  gate: { yes?: boolean; interactive: boolean; tty: boolean; answer?: "y" | "n" },
  to: "plan.hint" | "plan.reuse",
  label: string,
): Scenario {
  const b = new ScenarioBuilder({ id, title, flows: ["plan-pipeline"], summary });
  toGate(b, PLAN);
  const { decision, output } = decide("planGate", (g: typeof gate) => planGate(g), gate);
  b.add({
    node: to,
    edge: ["plan.gate", to, label],
    decision,
    narration:
      to === "plan.hint"
        ? `planGate returns '${output}': orch prints the create, route and autopilot commands and stops.`
        : `planGate returns '${output}': the pipeline runs on to issue creation.`,
  });
  return b.build();
}

const planGateAsk = gateScenario(
  "plan-gate-ask",
  "Plan gate: ask on a terminal",
  "An interactive session on a TTY asks once; a yes starts the pipeline.",
  { interactive: true, tty: true, answer: "y" },
  "plan.reuse",
  "ask (y)",
);

const planGateRun = gateScenario(
  "plan-gate-run",
  "Plan gate: --yes",
  "--yes approves up front, so the gate lets the pipeline run without asking.",
  { yes: true, interactive: false, tty: false },
  "plan.reuse",
  "--yes",
);

const planGateHint = gateScenario(
  "plan-gate-hint",
  "Plan gate: no terminal, no --yes",
  "Without a TTY or --yes the gate only prints the commands to run.",
  { interactive: false, tty: false },
  "plan.hint",
  "no TTY",
);

const planGateDeclined = gateScenario(
  "plan-gate-declined",
  "Plan gate: declined",
  "Answering no at the prompt prints the commands instead of starting anything.",
  { interactive: true, tty: true, answer: "n" },
  "plan.hint",
  "declined",
);

/** The blocking-error path: a duplicate id stops the plan before the gate. */
const planBlocked = ((): Scenario => {
  const b = new ScenarioBuilder({
    id: "plan-blocked",
    title: "Plan blocked by an error",
    flows: ["plan-pipeline"],
    summary: "A duplicate ticket id is a blocking error: validation stops before any approval or creation.",
  });
  toGate(b, [
    { id: "model", title: "Add the data model" },
    { id: "model", title: "Add the data model again" },
  ]);
  return b.build();
})();

/** The warning path, then creation: an unknown dependency is dropped, the plan still proceeds. */
const planCreate = ((): Scenario => {
  const tickets: Ticket[] = [...PLAN, { id: "docs", title: "Document it", dependsOn: ["nope"], files: ["src/api.ts"] }];
  const b = new ScenarioBuilder({
    id: "plan-create",
    title: "Plan with warnings, then create",
    flows: ["plan-pipeline"],
    summary: "Warnings (a dropped dependency, a shared file) are advisory; issues are created from the validated plan.",
  });
  toGate(b, tickets);
  const gate = decide("planGate", planGate, { yes: true, interactive: false, tty: false });
  b.add({ node: "plan.reuse", edge: ["plan.gate", "plan.reuse", "--yes"], decision: gate.decision, narration: "--yes: the pipeline runs. First, which tickets already have issues?" });
  const markers = buildPlanMarkers(tickets);
  const found = decide("indexByMarker", (i: Issue[]) => indexByMarker(i, markers.tickets), [] as Issue[]);
  b.add({
    node: "plan.create",
    edge: ["plan.reuse", "plan.create", "no marker"],
    decision: found.decision,
    narration: "No existing issue carries these deterministic ticket markers, so every ticket is created, carrying its marker for next time.",
  });
  for (const [n, t] of tickets.entries()) b.patch(n + 1, { title: t.title, agent: t.agent ?? null, deps: [] });
  b.add({
    node: "route.assign",
    edge: ["plan.create", "route.assign", "created"],
    narration: "The issues exist; whatever the plan left unrouted goes to the judge next.",
  });
  return b.build();
})();

/** Re-running an approved plan: markers already on GitHub are reused, nothing is duplicated. */
const planRerun = ((): Scenario => {
  const b = new ScenarioBuilder({
    id: "plan-rerun",
    title: "Idempotent re-run reuses issues",
    flows: ["plan-pipeline"],
    summary: "Deterministic plan and ticket markers let a repeated or resumed run reuse the issues it already created.",
  });
  toGate(b, PLAN);
  const gate = decide("planGate", planGate, { yes: true, interactive: false, tty: false });
  b.add({ node: "plan.reuse", edge: ["plan.gate", "plan.reuse", "--yes"], decision: gate.decision, narration: "--yes again, as after an interrupted run." });
  const markers = buildPlanMarkers(PLAN);
  const existing = PLAN.map((t, i) => issue(40 + i, ["status:todo"], renderTicketBody(t, [], { plan: markers.plan, ticket: markers.tickets[i]! })));
  const found = decide("indexByMarker", (i: Issue[]) => indexByMarker(i, markers.tickets), existing);
  b.add({
    node: "route.assign",
    edge: ["plan.reuse", "route.assign", "marker found"],
    decision: found.decision,
    narration: `All ${found.output.size} ticket markers are already on issues #40 and #41: they are reused, not recreated, and routing continues.`,
  });
  return b.build();
})();

const UNROUTED = [issue(51, ["status:todo"]), issue(52, ["status:todo"])];

function routingScenario(id: string, title: string, summary: string, plan: PlanEntry[], to: "state.ready" | "route.skipped"): Scenario {
  const open = UNROUTED.map((i) => i.number);
  const b = new ScenarioBuilder(
    { id, title, flows: ["routing"], summary },
    open.map((n) => baseTask(n)),
  );
  b.add({ node: "route.assign", narration: "Two open issues have neither agent: nor effort:. The whole open graph goes to the lead as a routing brief." });
  b.add({ node: "route.judge", edge: ["route.assign", "route.judge"], narration: "The lead runs headless with fresh context and replies with a routing plan." });
  const report = decide("evaluatePlan", (p: PlanEntry[]) => evaluatePlan(p, UNROUTED, { agents: AGENTS }), plan);
  b.add({
    node: "route.eval",
    edge: ["route.judge", "route.eval"],
    narration: `The plan is checked against the contract: ${report.output.ok ? "complete and valid" : `${report.output.violations.length} violation(s)`}.`,
  });
  const applied = decide("applyPlan", (p: PlanEntry[]) => applyPlan(p, UNROUTED, { agents: AGENTS }), plan);
  b.add({
    node: "route.apply",
    edge: ["route.eval", "route.apply"],
    decision: report.decision,
    narration: "Evaluation is advisory: gaps would warn on stderr, but never block applying.",
  });
  for (const w of applied.output.writes) b.patch(w.issue, { agent: w.agent });
  b.add({
    node: to,
    edge: ["route.apply", to],
    decision: applied.decision,
    narration:
      to === "state.ready"
        ? `${applied.output.writes.length} valid entries are written as labels, only where routing was blank; the issues are ready to claim.`
        : `${applied.output.skips.length} entry skipped (${applied.output.skips.map((s) => s.reason).join("; ")}); the issue stays unrouted and is never claimed.`,
  });
  return b.build();
}

const routingJudge = routingScenario(
  "routing-judge",
  "Judge routes the backlog",
  "The lead judge returns a plan; valid entries fill in blank agent:/effort: labels.",
  [
    { issue: 51, agent: "claude", effort: "hard", rationale: "Cross-cutting refactor; the stronger tier fits." },
    { issue: 52, agent: "codex", effort: "easy", rationale: "A small localized change." },
  ],
  "state.ready",
);

const routingSkip = routingScenario(
  "routing-skip",
  "Judge entry skipped",
  "An entry naming an unconfigured agent is skipped at write time; the issue stays unrouted.",
  [{ issue: 51, agent: "gemini", effort: "hard", rationale: "Wrong agent." }],
  "route.skipped",
);

/** One issue, claim to merge, then the autopilot concludes the plan is complete. */
const happyPath = ((): Scenario => {
  const N = 21;
  const PR = 121;
  const todo = issue(N, ["status:todo", "agent:claude"], "Implement the feature.");
  const open = [todo];
  const b = new ScenarioBuilder(
    { id: "happy-path", title: "Claim, run, review, merge, plan complete", flows: ["claim-run", "cross-review", "advisory-order", "report"], summary: "One routed task flows from todo to merged under the real deciders; the scoped autopilot then reports the plan complete." },
    [{ ...baseTask(N), title: todo.title, agent: "claude" }],
  );
  const facts = (over: Partial<TaskFacts>): TaskFacts => ({ issue: "open", lock: false, worktree: false, branch: "absent", pr: "none", telemetry: "none", ...over });
  const stepFacts = (over: Partial<StepFacts>): StepFacts => ({
    attention: false,
    pr: { number: PR, head: HEAD, checks: "pass", mergeable: "clean" },
    review: { approved: false, changesRequested: false },
    rounds: 0,
    maxRounds: 3,
    requireHumanMerge: false,
    ...over,
  });

  b.add({ node: "state.ready", narration: "Task #21 is open, routed to claude, with no lock or worktree: deriveTaskState says ready.", decision: decide("deriveTaskState", deriveTaskState, facts({})).decision });
  const claimable = decide("claimableBy", (i: Issue) => claimableBy(i, "claude", { requireRouted: true }), todo);
  b.add({ node: "route.eligible", edge: ["state.ready", "route.eligible"], decision: claimable.decision, narration: "The autopilot asks whether claude may take it: it is routed to claude, so yes." });
  const blockers = decide("openDepsFromMap", (i: Issue) => openDepsFromMap(i, byNumber(open)), todo);
  b.add({ node: "route.cycles", edge: ["route.eligible", "route.cycles"], decision: blockers.decision, narration: "No open Depends-on blockers." });
  const graph = decide("buildGraph", buildGraph, open);
  b.add({ node: "route.after", edge: ["route.cycles", "route.after"], decision: graph.decision, narration: "The dependency graph is acyclic, so the eligible set is ordered by advisory After: preferences." });
  const ordered = decide("orderByAfter", orderByAfter, open);
  b.add({ node: "run.claim", edge: ["route.after", "run.claim"], decision: ordered.decision, narration: "The lowest-preference eligible task is #21." });
  const claim = decide("decideTaskTransition", () => decideTaskTransition("ready", "claim"), null);
  b.add({ node: "run.saga", edge: ["run.claim", "run.saga"], decision: claim.decision, narration: "The claim saga takes a Git lock ref, projects status:claimed and registers a worktree." });
  b.patch(N, { status: "status:claimed", locked: true, worktree: "../wt/issue-21" });
  const claimed = decide("deriveTaskState", deriveTaskState, facts({ lock: true, worktree: true, branch: "unchanged" }));
  b.add({ node: "state.claimed", edge: ["run.saga", "state.claimed"], decision: claimed.decision, narration: "Setup is verified from observed facts: the lock is held and the worktree is registered." });
  b.patch(N, { status: "status:in-progress" });
  const start = decide("decideTaskTransition", () => decideTaskTransition("claimed", "start-work"), null);
  b.add({ node: "state.in-progress", edge: ["state.claimed", "state.in-progress"], decision: start.decision, narration: "The harness starts working in the worktree." });
  b.add({ node: "run.outcome", edge: ["state.in-progress", "run.outcome"], narration: "The harness exits; the run is classified from its exit code and commits." });
  b.add({ node: "run.submit", edge: ["run.outcome", "run.submit", "commits made"], narration: "It made commits, so orch pushes the branch and opens the PR." });
  b.patch(N, { status: "status:in-review", prNumber: PR, prChecks: "pass", latestRun: { tokensTotal: 48_000, costUsd: 0.62, ts: TS, model: "claude-sonnet-5-5@medium" } });
  const submitted = decide("deriveTaskState", deriveTaskState, facts({ lock: true, worktree: true, branch: "ahead", pr: "open", telemetry: "submitted" }));
  b.add({ node: "state.in-review", edge: ["run.submit", "state.in-review"], decision: submitted.decision, narration: "An open PR on the task branch with nothing requested: the task is in-review." });

  b.add({ node: "auto.observe", edge: ["state.in-review", "auto.observe"], narration: "The autopilot polls open PRs and re-derives their facts from GitHub." });
  b.add({ node: "auto.decide", edge: ["auto.observe", "auto.decide"], narration: "Observed: CI green, no conflicts, no approval on the current head." });
  const step = decide("decideStep", decideStep, stepFacts({}));
  b.add({ node: "step.review", edge: ["auto.decide", "step.review"], decision: step.decision, narration: "decideStep returns 'review': the head has no accepted approval yet." });
  b.add({ node: "review.pick", edge: ["step.review", "review.pick"], narration: "The step runs the reviewer; first, who reviews?" });
  const pick = decide(
    "pickReviewer",
    (i: { author: string; agents: string[]; policy: "cross-or-self"; unavailable: string[] }) => pickReviewer({ ...i, unavailable: new Set(i.unavailable) }),
    { author: "claude", agents: AGENTS, policy: "cross-or-self", unavailable: [] },
  );
  b.add({ node: "review.cross", edge: ["review.pick", "review.cross", "other harness"], decision: pick.decision, narration: "codex is available, so the author never reviews its own work." });
  b.add({ node: "review.run", edge: ["review.cross", "review.run"], narration: "codex reviews read-only in a throwaway checkout of exactly the PR head." });
  b.add({ node: "review.verdict", edge: ["review.run", "review.verdict"], narration: "The reply must contain a fenced JSON verdict; anything else fails closed." });
  const reply = 'Looks correct.\n```json\n{"decision":"approve","notes":"Tests cover the change."}\n```';
  const verdict = decide("parseVerdict", parseVerdict, reply);
  b.add({ node: "review.approve", edge: ["review.verdict", "review.approve"], decision: verdict.decision, narration: "The verdict is 'approve'; it is recorded as a head-bound review on the PR." });
  b.patch(N, { reviewedBy: ["codex"] });
  const record = formatReview({ reviewer: "codex", pr: PR, head: HEAD, timestamp: TS, decision: "approve" }, "Approved.");
  const state = reviewState([{ id: 1, body: record, state: "COMMENTED", commit_id: HEAD }], PR, HEAD);
  const accepted = decide("acceptedReviewers", () => acceptedReviewers(state, "claude", "cross-or-self"), null);
  b.add({ node: "review.gate", edge: ["review.approve", "review.gate"], decision: accepted.decision, narration: "codex's approval on the current head is the one accepted reviewer; labels never authorize a merge." });
  const gate = decide("evaluateGate", evaluateGate, {
    author: "claude", reviewers: accepted.output, selfReviewers: state.selfReviewers, reviewPolicy: "cross-or-self" as const,
    agents: AGENTS, requireCrossReview: true, checksPass: true, checksDetail: "all checks passed", requireHumanMerge: false, humanApproved: false,
  });
  b.add({ node: "review.merge", edge: ["review.gate", "review.merge"], decision: gate.decision, narration: "evaluateGate returns no blocking reasons: approved by the other harness, CI green." });
  const merge = decide("decideTaskTransition", () => decideTaskTransition("in-review", "merge"), null);
  b.add({ node: "review.cleanup", edge: ["review.merge", "review.cleanup"], decision: merge.decision, narration: "The SHA-guarded merge lands; the claim lock is released and the worktree is pruned only if it is safe." });
  b.patch(N, null);
  const done = decide("deriveTaskState", deriveTaskState, facts({ issue: "closed", branch: "ahead", pr: "merged", telemetry: "submitted" }));
  b.add({ node: "state.done", edge: ["review.cleanup", "state.done", "removed"], decision: done.decision, narration: "Merged, closed, no retained lock or worktree: done, and off the board." });

  const next = decide("decideStep", decideStep, stepFacts({ pr: null }));
  b.add({ node: "auto.decide", decision: next.decision, narration: "The next autopilot pass re-derives everything: #21 has no open PR and nothing else in the plan is open." });
  b.add({ node: "auto.report", edge: ["auto.decide", "auto.report"], decision: next.decision, narration: "No scoped issue remains open without needs-attention: the run stops 'plan-complete' and prints its report." });
  return b.build();
})();

/** Every scenario in this file, in play order. */
export const CORE_SCENARIOS: readonly Scenario[] = [
  planGateAsk,
  planGateRun,
  planGateHint,
  planGateDeclined,
  planBlocked,
  planCreate,
  planRerun,
  routingJudge,
  routingSkip,
  happyPath,
];
