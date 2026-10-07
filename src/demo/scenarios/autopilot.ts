// Faked external outcomes; every policy decision runs the production pure decider.
import { evaluateGate } from "../../board/review.js";
import { parseVerdict } from "../../board/review-run.js";
import { decideStep, type StepFacts } from "../../tasks/steps.js";
import { formatTriageComment, parseTriageDecision, triageFacts } from "../../tasks/triage.js";
import { baseTask, decide, ScenarioBuilder, type Decision, type Scenario } from "../scenario-engine.js";
import type { FlowId } from "../flow-graph.js";

const ISSUE = 93;
const PR = 193;
const HEAD = "a".repeat(40);
const NEXT_HEAD = "b".repeat(40);
const GUIDANCE = "Fix the boundary condition and run the regression test before pushing.";

function facts(over: Partial<StepFacts> = {}): StepFacts {
  return {
    attention: false, pr: { number: PR, head: HEAD, checks: "pass", mergeable: "clean" },
    review: { approved: false, changesRequested: false }, rounds: 0, maxRounds: 3,
    requireHumanMerge: false, triages: 0, maxTriages: 1, extraRounds: 0, ...over,
  };
}

/** Small walk helper: outcomes are fake I/O, decisions are recorded separately. */
class Walk {
  readonly b: ScenarioBuilder;
  node = "auto.observe";
  constructor(id: string, title: string, flows: FlowId[], summary: string) {
    this.b = new ScenarioBuilder({ id, title, flows, summary }, [{
      ...baseTask(ISSUE), agent: "codex", status: "status:in-review", prNumber: PR,
      prChecks: "pass", locked: true, worktree: "../wt/issue-93",
    }]);
    this.b.add({ node: this.node, narration: summary });
  }
  to(node: string, narration: string, decision?: Decision, label?: string): void {
    this.b.add({ node, edge: [this.node, node, label], narration, ...(decision ? { decision } : {}) });
    this.node = node;
  }
  step(input: StepFacts, observation?: Decision): ReturnType<typeof decideStep> {
    this.b.patch(ISSUE, { prChecks: input.pr?.checks ?? null });
    this.to("auto.decide", "Re-observe the current head, review, CI and budgets; signals alone never authorize work.", observation);
    const result = decide("decideStep", decideStep, input);
    this.to(`step.${result.output.kind}`, `decideStep chooses ${JSON.stringify(result.output)}.`, result.decision,
      result.output.kind === "fix" ? result.output.reason === "ci" ? "CI failing" : "changes requested" : undefined);
    return result.output;
  }
  review(changes: boolean): void {
    this.to("review.pick", "Pick the available other harness, claude.");
    this.to("review.cross", "Cross-review by claude.");
    this.to("review.run", "Review read-only in a detached checkout of exactly this head.");
    this.to("review.verdict", "The reviewer returns a fenced JSON verdict.");
    const result = decide("parseVerdict", parseVerdict,
      `\`\`\`json\n${JSON.stringify({ decision: changes ? "request-changes" : "approve", notes: changes ? "Fix the boundary condition." : "Regression covered." })}\n\`\`\``);
    this.to(changes ? "review.changes" : "review.approve", "Record the verdict bound to the inspected head.", result.decision);
    this.b.patch(ISSUE, { reviewedBy: changes ? [] : ["claude"] });
    if (changes) {
      this.b.patch(ISSUE, { status: "status:in-progress" });
      this.to("state.in-progress", "The author receives the change request.");
    } else {
      this.to("review.gate", "The head-bound cross-approval can enter the gate.");
      // Return to observation via the blocked gate: CI on the newly pushed head is still pending.
      this.b.patch(ISSUE, { prChecks: "pending" });
      this.to("state.in-review", "CI is pending, so approval alone cannot merge.", gate(false).decision);
    }
    this.to("auto.observe", "Poll again after the review outcome.");
  }
  push(conflict = false): void {
    this.b.patch(ISSUE, { status: "status:in-progress", reviewedBy: [] });
    this.to("auto.push", conflict
      ? "Merge origin/main into the task branch, never rebase; verify the base is an ancestor before the non-forced push."
      : "Resume the author's saved session, apply feedback, verify the worktree again, then push HEAD to the task branch without force.");
    this.b.patch(ISSUE, { status: "status:in-review", prChecks: "pending" });
    this.to("state.in-review", "The push creates a new head; restore review:needed and invalidate the previous approval.");
    this.to("auto.observe", "Observe the new head before choosing another step.");
  }
  merge(): void {
    this.to("review.gate", "Merge always rechecks the real policy gate.");
    this.to("review.merge", "Cross-approval and green CI leave no blocking reasons.", gate(true).decision);
    this.to("review.cleanup", "SHA-guarded merge; release the lock and safely prune the worktree.");
    this.b.patch(ISSUE, null);
    this.to("state.done", "The merged issue closes and leaves the board.");
  }
  handoff(input: StepFacts): void {
    this.b.patch(ISSUE, { status: "needs-attention" });
    this.to("auto.handoff", "Add needs-attention and a PR comment explaining the diagnosis and how a human can hand the task back.");
    this.to("step.none", "A later pass sees human ownership and drives nothing.", decide("decideStep", decideStep, { ...input, attention: true }).decision);
  }
}

function gate(checksPass: boolean) {
  return decide("evaluateGate", evaluateGate, {
    author: "codex", reviewers: ["claude"], agents: ["claude", "codex"], requireCrossReview: true,
    checksPass, checksDetail: checksPass ? "all passed" : "pending", requireHumanMerge: false, humanApproved: false,
  });
}

function fixScenario(id: string, title: string, kind: "review" | "ci" | "conflict"): Scenario {
  const w = new Walk(id, title, [kind === "ci" ? "ci-fix" : kind === "conflict" ? "conflict" : "autopilot-fix", "cross-review"],
    "The loop re-derives each step from observed facts and reviews every changed head before merging.");
  if (kind === "review") { w.step(facts()); w.review(true); }
  w.step(facts({
    review: { approved: false, changesRequested: kind === "review" },
    pr: { number: PR, head: HEAD, checks: kind === "ci" ? "fail" : "pass", mergeable: kind === "conflict" ? "conflicting" : "clean" },
  }));
  w.push(kind === "conflict");
  w.step(facts({ rounds: 1, pr: { number: PR, head: NEXT_HEAD, checks: "pending", mergeable: "clean" } }));
  w.review(false);
  w.step(facts({ rounds: 1, pr: { number: PR, head: NEXT_HEAD, checks: "pass", mergeable: "clean" }, review: { approved: true, changesRequested: false } }));
  w.merge();
  return w.b.build();
}

function waitScenario(id: string, unknown: boolean): Scenario {
  const w = new Walk(id, unknown ? "Wait for mergeability" : "Wait for CI", ["autopilot-fix"], "An approved head waits for external facts to settle.");
  w.b.patch(ISSUE, { reviewedBy: ["claude"] });
  w.step(facts({ review: { approved: true, changesRequested: false }, pr: { number: PR, head: HEAD, checks: unknown ? "pass" : "pending", mergeable: unknown ? "unknown" : "clean" } }));
  w.to("auto.observe", "Poll again; waiting spends no fix round.");
  w.step(facts({ review: { approved: true, changesRequested: false } }));
  w.merge();
  return w.b.build();
}

function triageScenario(id: string, retry: boolean, disabled = false): Scenario {
  const w = new Walk(id, disabled ? "Triage disabled" : retry ? "Lead grants a guided hard retry" : "Lead escalates", ["triage", "escalation"],
    "Three spent fix rounds exhaust the budget; the lead may grant one guided round or hand off to a human.");
  const input = facts({ rounds: 3, maxTriages: disabled ? 0 : 1, review: { approved: false, changesRequested: true } });
  w.step(input);
  if (disabled) { w.handoff(input); return w.b.build(); }
  const verdict = decide("parseTriageDecision", parseTriageDecision, `\`\`\`json\n${JSON.stringify(retry
    ? { decision: "retry", effort: "hard", guidance: GUIDANCE }
    : { decision: "escalate", diagnosis: "The spec has contradictory boundary requirements.", question: "Which boundary behavior should win?" })}\n\`\`\``);
  if (verdict.output?.decision !== "retry") {
    w.to("step.escalate", "Record the diagnosis; the human must resolve the conflicting requirements.", verdict.decision);
    w.handoff(input);
    return w.b.build();
  }
  const comments = [{ id: 1, body: formatTriageComment({ pr: PR, head: HEAD, timestamp: "2026-01-01T00:00:00.000Z", decision: "retry", extraRounds: 1, effort: verdict.output.effort },
    { issue: ISSUE, reason: "round budget spent", text: verdict.output.guidance }) }];
  w.to("auto.observe", "Write the durable triage comment, replace effort:easy with effort:hard, then re-observe.", verdict.decision);
  const recovered = decide("triageFacts", (i: { comments: typeof comments; pr: number; maxTriages: number }) => triageFacts(i.comments, i.pr, i.maxTriages), { comments, pr: PR, maxTriages: 1 });
  w.step({ ...input, triages: recovered.output.triages, extraRounds: recovered.output.extraRounds }, recovered.decision);
  w.push();
  w.step(facts({ rounds: 4, triages: 1, extraRounds: 1 }));
  w.review(false);
  w.step(facts({ rounds: 4, triages: 1, extraRounds: 1, review: { approved: true, changesRequested: false } }));
  w.merge();
  return w.b.build();
}

const human = new Walk("autopilot-await-human", "Human merge required", ["autopilot-fix"], "An approved green PR waits for the configured human merge gate.");
human.b.patch(ISSUE, { reviewedBy: ["claude"] });
human.step(facts({ requireHumanMerge: true, review: { approved: true, changesRequested: false } }));

// Production filters twins before any per-PR lookup or decideStep call. This is deliberately an observation-only cut.
const ambiguous = new ScenarioBuilder({ id: "autopilot-ambiguous", title: "Ambiguous twin PRs", flows: ["autopilot-fix"], summary: "Twin PRs are reported and neither is driven." }, [{ ...baseTask(ISSUE), status: "status:in-review", agent: "codex" }])
  .add({ node: "auto.observe", narration: "Observation reports issue #93 with open PRs #193 and #194 as ambiguous before per-PR reads. Neither gets a decideStep call; a human must choose." }).build();

export const AUTOPILOT_SCENARIOS: readonly Scenario[] = [
  fixScenario("autopilot-review-fix", "Changes, resumed fix, re-review, merge", "review"),
  fixScenario("autopilot-ci-fix", "Fix failing CI", "ci"),
  fixScenario("autopilot-conflict", "Merge the base to resolve conflict", "conflict"),
  waitScenario("autopilot-wait-ci", false), waitScenario("autopilot-wait-mergeability", true),
  human.b.build(), triageScenario("autopilot-triage-retry", true),
  triageScenario("autopilot-triage-escalate", false), triageScenario("autopilot-triage-disabled", false, true), ambiguous,
];
