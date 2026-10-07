// The scenario engine: scripted walks through the flow graph whose every decision is made by the
// real pure deciders. Frames are plain data (no IO, no timers); the drift check below fails when a
// decider's output no longer leads along the edge a frame claims to take.
import { EDGES, NODES, STATE_NODES, STEP_NODES, type FlowEdge, type FlowId } from "./flow-graph.js";
import type { TaskView } from "../board/snapshot.js";
import type { Verdict } from "../board/review-run.js";
import type { ReviewerPick } from "../board/reviewer.js";
import type { PlanGate } from "../commands/plan-pipeline.js";
import type { PlannedAssignments } from "../routing/assign.js";
import type { DepGraph } from "../board/graph.js";
import type { Issue } from "../github/github.js";
import type { ResolvedPlan } from "../tasks/plan.js";
import type { Step } from "../tasks/steps.js";
import type { TaskEvent, TaskState, TaskStateKind, TransitionDecision } from "../tasks/lifecycle.js";
import type { RepairPlan } from "../tasks/reconcile.js";

/** What the board projection (`assemble`) derives per task, minus the fields derived from facts. */
export type ScenarioTask = Omit<TaskView, "health" | "recoveryCommand" | "issueState" | "blockers" | "prUrl">;

/** One real decider call: its name, what it was given, and what it returned. */
export interface Decision {
  fn: string;
  input: unknown;
  output: unknown;
}

export interface Frame {
  /** Stable `<scenario>:<nn>` id. */
  id: string;
  narration: string;
  /** Node the walk is at after this frame. */
  activeNode: string;
  /** Id of the edge taken to arrive at `activeNode`; absent for a cut (the first frame, or a new pass). */
  edge?: string;
  board: ScenarioTask[];
  /** The decision, made at the edge's source, that leads along `edge`. */
  decision?: Decision;
}

export interface Scenario {
  id: string;
  title: string;
  flows: FlowId[];
  summary: string;
  frames: Frame[];
}

export class ScenarioDriftError extends Error {
  constructor(frame: string, detail: string) {
    super(`scenario drift at ${frame}: ${detail}`);
    this.name = "ScenarioDriftError";
  }
}

const nodeIds = new Set(NODES.map((n) => n.id));
const edgeById = new Map(EDGES.map((e) => [e.id, e]));

/** `[from, to, labelPart?]`: the edge between two nodes, disambiguated by a label fragment when parallel edges exist. */
export type EdgeRef = readonly [from: string, to: string, labelPart?: string];

export function resolveEdge([from, to, labelPart]: EdgeRef): FlowEdge {
  const matches = EDGES.filter((e) => e.from === from && e.to === to && (!labelPart || e.label.includes(labelPart)));
  if (matches.length !== 1) {
    throw new Error(`edge ${from} -> ${to}${labelPart ? ` ("${labelPart}")` : ""} matches ${matches.length} edges, expected 1`);
  }
  return matches[0]!;
}

/** Call a real decider and record the call. */
export function decide<I, O>(fn: string, impl: (input: I) => O, input: I): { decision: Decision; output: O } {
  const output = impl(input);
  return { decision: { fn, input, output }, output };
}

type Check = (d: Decision, e: FlowEdge) => string | null;

const toState = (kind: string, to: string): string | null => {
  const node = STATE_NODES[kind as keyof typeof STATE_NODES];
  return to === node ? null : `derived '${kind}' (${node}) but the walk arrives at ${to}`;
};

/** The lifecycle transition each stage hand-off stands for; `decideTaskTransition` must agree exactly. */
const TRANSITION_EDGES: Record<string, { from: TaskStateKind; event: TaskEvent; to: TaskStateKind }> = {
  "run.claim>run.saga": { from: "ready", event: "claim", to: "claimed" },
  "state.claimed>state.in-progress": { from: "claimed", event: "start-work", to: "in-progress" },
  "review.merge>review.cleanup": { from: "in-review", event: "merge", to: "done" },
  "run.outcome>run.fail": { from: "in-progress", event: "run-failed", to: "needs-attention" },
  "run.outcome>run.nocommit": { from: "in-progress", event: "run-failed", to: "needs-attention" },
};

/**
 * For each decider, does its recorded output lead along the scripted edge? A null return is agreement.
 * This is the single place where a decider's contract is tied to the graph; adding a decider to a
 * scenario means adding its check here.
 */
const CHECKS: Record<string, Check> = {
  detectUsageLimit(d, e) {
    return d.output !== null && e.from === "run.outcome" && e.to === "run.usage"
      ? null : "only a usage limit in this run's log leads to run.usage";
  },
  planRepairs(d, e) {
    const plan = d.output as RepairPlan;
    return e.from === "rec.repair" && e.to === "rec.derive" && plan.blocked.length === 0
      ? null : "repair preview must be unblocked before applying its actions";
  },
  planGate(d, e) {
    const out = d.output as PlanGate;
    const answer = (d.input as { answer?: "y" | "n" }).answer;
    if (out === "ask" && answer === undefined) return "an 'ask' gate needs the human's answer in its input";
    if (e.from !== "plan.gate") return `planGate decides at plan.gate, not ${e.from}`;
    // Both hint edges end at plan.hint, so the edge itself (not its target) says which outcome is scripted.
    const declined = e.label.startsWith("declined");
    const noTty = e.label.startsWith("no TTY");
    const ok = declined ? out === "ask" && answer === "n" : noTty ? out === "hint" : e.to === "plan.reuse" && (out === "run" || (out === "ask" && answer === "y"));
    return ok ? null : `planGate -> '${out}'${answer ? ` (answer ${answer})` : ""} contradicts edge "${e.label}"`;
  },
  resolvePlan(d, e) {
    const blocked = (d.output as ResolvedPlan).errors.length > 0;
    const to = blocked ? "plan.blocked" : "plan.gate";
    return e.from === "plan.resolve" && e.to === to ? null : `resolvePlan (${blocked ? "errors" : "valid"}) leads to ${to}, not ${e.to}`;
  },
  indexByMarker(d, e) {
    const found = d.output as Record<string, number[]>;
    const markers = (d.input as { markers: string[] }).markers;
    const missing = markers.filter((m) => !found[m]?.length).length;
    // Only a complete match skips creation; any unmatched ticket still has to be created.
    const to = missing === 0 ? "route.assign" : "plan.create";
    return e.from === "plan.reuse" && e.to === to
      ? null
      : `marker lookup (${markers.length - missing}/${markers.length} tickets matched) leads to ${to}, not ${e.to}`;
  },
  evaluatePlan(d, e) {
    // Advisory: a violation warns but never blocks, so the plan always proceeds to apply.
    return e.from === "route.eval" && e.to === "route.apply" ? null : `evaluatePlan is advisory and must lead to route.apply, not ${e.to}`;
  },
  applyPlan(d, e) {
    const out = d.output as PlannedAssignments;
    const to = out.writes.length > 0 ? "state.ready" : "route.skipped";
    return e.from === "route.apply" && e.to === to ? null : `applyPlan (${out.writes.length} writes, ${out.skips.length} skips) leads to ${to}, not ${e.to}`;
  },
  claimableBy(d, e) {
    return d.output === true && e.to === "route.eligible" ? null : `claimableBy returned ${String(d.output)} for an edge to ${e.to}`;
  },
  openDepsFromMap(d, e) {
    return (d.output as number[]).length === 0 && e.to === "route.cycles" ? null : `open dependencies ${JSON.stringify(d.output)} block the edge to ${e.to}`;
  },
  buildGraph(d, e) {
    const to = (d.output as DepGraph).cycles.length > 0 ? "route.cycle-deadlock" : "route.after";
    return e.from === "route.cycles" && e.to === to ? null : `buildGraph leads to ${to}, not ${e.to}`;
  },
  orderByAfter(d, e) {
    return (d.output as Issue[]).length > 0 && e.to === "run.claim" ? null : `orderByAfter yielded no candidate for an edge to ${e.to}`;
  },
  decideTaskTransition(d, e) {
    const t = d.output as TransitionDecision;
    if (!t.allowed) return `transition ${t.from} --${t.event}--> is illegal: ${t.reason}`;
    const want = TRANSITION_EDGES[`${e.from}>${e.to}`];
    if (!want) return `no transition is expected on edge ${e.from} -> ${e.to}`;
    return t.from === want.from && t.event === want.event && t.to === want.to
      ? null
      : `edge ${e.from} -> ${e.to} expects ${want.from} --${want.event}--> ${want.to}, got ${t.from} --${t.event}--> ${t.to}`;
  },
  deriveTaskState(d, e) {
    return toState((d.output as TaskState).kind, e.to);
  },
  pickReviewer(d, e) {
    const pick = d.output as ReviewerPick | null;
    if (!pick) return "pickReviewer found nobody to review";
    const to = pick.mode === "cross" ? "review.cross" : "review.self";
    return e.from === "review.pick" && e.to === to ? null : `pickReviewer -> ${pick.mode} leads to ${to}, not ${e.to}`;
  },
  parseVerdict(d, e) {
    const v = d.output as Verdict | null;
    const to = v === null ? "review.failclosed" : v.decision === "approve" ? "review.approve" : "review.changes";
    return e.from === "review.verdict" && e.to === to ? null : `parseVerdict leads to ${to}, not ${e.to}`;
  },
  acceptedReviewers(d, e) {
    return (d.output as string[]).length > 0 && e.from === "review.approve" && e.to === "review.gate"
      ? null
      : `acceptedReviewers ${JSON.stringify(d.output)} does not carry an approval to the gate (${e.to})`;
  },
  evaluateGate(d, e) {
    const reasons = d.output as string[];
    const to = reasons.length === 0 ? "review.merge" : "state.in-review";
    return e.from === "review.gate" && e.to === to ? null : `evaluateGate (${reasons.length} blocking reasons) leads to ${to}, not ${e.to}`;
  },
  planOutcome(d, e) {
    // The edge reports both outcomes; a frame that scripts plan-complete needs the decider to agree.
    return e.from === "auto.decide" && e.to === "auto.report" && d.output === "plan-complete"
      ? null
      : `planOutcome returned '${String(d.output)}' on a frame that scripts plan-complete`;
  },
  decideStep(d, e) {
    const step = d.output as Step;
    const noPr = (d.input as { pr: unknown }).pr === null;
    if (e.from === "auto.decide" && e.to === "auto.report") {
      return step.kind === "none" && noPr ? null : `only a PR-less 'none' step reports (got '${step.kind}')`;
    }
    return e.from === "auto.decide" && e.to === STEP_NODES[step.kind] ? null : `decideStep -> '${step.kind}' leads to ${STEP_NODES[step.kind]}, not ${e.to}`;
  },
};

/** Throws a {@link ScenarioDriftError} when a frame's decider output does not lead along its scripted edge. */
export function checkFrame(frame: Frame): void {
  if (!nodeIds.has(frame.activeNode)) throw new ScenarioDriftError(frame.id, `unknown node '${frame.activeNode}'`);
  if (!frame.edge) {
    // A cut has no edge to follow, but a derived lifecycle state must still be the node it lands on.
    const d = frame.decision;
    const problem = d?.fn === "deriveTaskState" ? toState((d.output as TaskState).kind, frame.activeNode) : null;
    if (problem) throw new ScenarioDriftError(frame.id, problem);
    if (d?.fn === "pickReviewer" && (frame.activeNode !== "review.pick" || d.output !== null)) {
      throw new ScenarioDriftError(frame.id, "a refused reviewer pick must stop at review.pick with null output");
    }
    return;
  }
  const edge = edgeById.get(frame.edge);
  if (!edge) throw new ScenarioDriftError(frame.id, `unknown edge '${frame.edge}'`);
  if (edge.to !== frame.activeNode) throw new ScenarioDriftError(frame.id, `edge ${edge.id} ends at ${edge.to}, not ${frame.activeNode}`);
  if (!frame.decision) return;
  const check = CHECKS[frame.decision.fn];
  if (!check) throw new ScenarioDriftError(frame.id, `no drift check registered for decider '${frame.decision.fn}'`);
  const problem = check(frame.decision, edge);
  if (problem) throw new ScenarioDriftError(frame.id, problem);
}

/** Re-verify a whole scenario: every frame agrees with its edge, and consecutive frames follow declared edges. */
export function checkScenario(scenario: Scenario): void {
  if (scenario.frames.length === 0) throw new ScenarioDriftError(scenario.id, "has no frames");
  let previous: Frame | undefined;
  for (const frame of scenario.frames) {
    checkFrame(frame);
    // A cut is only legal as the opening frame; every later frame must follow a declared edge.
    if (previous && !frame.edge) throw new ScenarioDriftError(frame.id, "has no edge: only a scenario's first frame may be a cut");
    if (frame.edge && previous) {
      const edge = edgeById.get(frame.edge)!;
      if (edge.from !== previous.activeNode) {
        throw new ScenarioDriftError(frame.id, `edge ${edge.id} starts at ${edge.from} but the walk was at ${previous.activeNode}`);
      }
    }
    previous = frame;
  }
}

export interface FrameSpec {
  narration: string;
  node: string;
  /** The edge taken to arrive here; omit for a cut (the first frame, or a new pass). */
  edge?: EdgeRef;
  decision?: Decision;
}

/** Accumulates frames over an evolving board, verifying each one as it is added. */
export class ScenarioBuilder {
  private readonly frames: Frame[] = [];
  private tasks: ScenarioTask[];

  constructor(
    private readonly meta: Omit<Scenario, "frames">,
    initialBoard: readonly ScenarioTask[] = [],
  ) {
    this.tasks = structuredClone([...initialBoard]);
  }

  /** Change one task on the board before the next frame is recorded; with no patch, remove it. */
  patch(number: number, change: Partial<ScenarioTask> | null): this {
    if (change === null) this.tasks = this.tasks.filter((t) => t.number !== number);
    else {
      const index = this.tasks.findIndex((t) => t.number === number);
      if (index < 0) this.tasks.push({ ...baseTask(number), ...change });
      else this.tasks[index] = { ...this.tasks[index]!, ...change };
    }
    return this;
  }

  add(spec: FrameSpec): this {
    const frame: Frame = {
      id: `${this.meta.id}:${String(this.frames.length + 1).padStart(2, "0")}`,
      narration: spec.narration,
      activeNode: spec.node,
      ...(spec.edge ? { edge: resolveEdge(spec.edge).id } : {}),
      board: structuredClone(this.tasks),
      ...(spec.decision ? { decision: spec.decision } : {}),
    };
    checkFrame(frame);
    this.frames.push(frame);
    return this;
  }

  build(): Scenario {
    const scenario: Scenario = { ...this.meta, frames: [...this.frames] };
    checkScenario(scenario);
    return scenario;
  }
}

/** A todo task with nothing attached; scenarios override what they need. */
export function baseTask(number: number): ScenarioTask {
  return {
    number,
    title: `Task #${number}`,
    status: "status:todo",
    agent: null,
    deps: [],
    after: [],
    prNumber: null,
    prChecks: null,
    reviewedBy: [],
    locked: false,
    worktree: null,
    latestRun: null,
  };
}
