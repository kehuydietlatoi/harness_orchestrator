import { describe, expect, it } from "vitest";
import { RECOVERY_SCENARIOS } from "../src/demo/scenarios/recovery.js";
import { SCENARIOS } from "../src/demo/scenarios/index.js";
import { checkFrame, checkScenario, type Decision } from "../src/demo/scenario-engine.js";
import { TASK_STATE_KINDS, decideTaskTransition } from "../src/tasks/lifecycle.js";
import { acceptedReviewers, type reviewState } from "../src/board/approval.js";
import { detectUsageLimit } from "../src/adapters/usage-limit.js";
import { planRepairs, type RepairPlan } from "../src/tasks/reconcile.js";
import type { Issue } from "../src/github/github.js";
import type { DepGraph } from "../src/board/graph.js";

const scenario = (id: string) => RECOVERY_SCENARIOS.find((s) => s.id === id)!;
const last = (id: string) => scenario(id).frames.at(-1)!;
const decision = (id: string, fn: string): Decision => scenario(id).frames.find((f) => f.decision?.fn === fn)!.decision!;

describe("recovery scenario contract", () => {
  it.each(RECOVERY_SCENARIOS.map((s) => [s.id, s] as const))("%s follows real deciders and connected graph edges", (_id, s) => {
    expect(() => checkScenario(s)).not.toThrow();
    expect(SCENARIOS).toContain(s);
  });

  it("shows every TaskStateKind in at least one derived frame", () => {
    const kinds = new Set(SCENARIOS.flatMap((s) => s.frames.flatMap((f) => f.decision?.fn === "deriveTaskState" ? [(f.decision.output as { kind: string }).kind] : [])));
    expect([...kinds].sort()).toEqual([...TASK_STATE_KINDS].sort());
  });

  it.each(["failed", "timeout", "no-commits"])("%s cleans up before needs-attention", (kind) => {
    const f = last(`run-${kind}`);
    expect(f.decision!.output).toMatchObject({ kind: "needs-attention", reason: kind === "no-commits" ? "no-commits" : "run-failed" });
    expect(f.board[0]).toMatchObject({ locked: false, worktree: null, status: "needs-attention" });
  });

  it("keeps failed-run work and reports the actual invariant instead of pretending cleanup succeeded", () => {
    const f = last("run-failed-retained");
    expect(f.board[0]).toMatchObject({ locked: true, worktree: "../wt/issue-71" });
    expect(f.decision!.output).toMatchObject({ kind: "inconsistent", violations: [{ invariant: "finished-run-requires-released-resources" }] });
    expect(decideTaskTransition("inconsistent", "reset").allowed).toBe(false);
  });

  it("plain abandon preserves dirty work; clean and explicit discard release resources but retain branch facts", () => {
    expect(last("abandon-retained").board[0]).toMatchObject({ locked: true, worktree: "../wt/issue-71", status: "needs-attention" });
    for (const id of ["abandon-clean", "abandon-discard"]) {
      expect(last(id).board[0]).toMatchObject({ locked: false, worktree: null, status: "status:todo", agent: null });
      expect(last(id).decision!.output).toMatchObject({ kind: "needs-attention", reason: "pr-closed" });
    }
    expect(scenario("abandon-discard").frames.some((f) => f.activeNode === "rec.discard")).toBe(true);
  });

  it("detects the own-run limit and requeues without unresolved failure telemetry", () => {
    const d = decision("usage-limit-requeue", "detectUsageLimit");
    expect(d.output).toMatchObject({ resetAt: "2026-01-01T01:00:00.000Z" });
    expect(last("usage-limit-requeue").decision!.output).toEqual({ kind: "ready" });
    expect(last("usage-limit-requeue").board[0]).toMatchObject({ status: "status:todo", locked: false, worktree: null });
    const oldLog = JSON.stringify({ type: "error", message: "usage limit" });
    const ownLog = JSON.stringify({ type: "assistant", message: "usage limit" });
    expect(detectUsageLimit((oldLog + "\n" + ownLog).slice(oldLog.length + 1))).toBeNull();
    const f = scenario("usage-limit-requeue").frames.find((f) => f.decision?.fn === "detectUsageLimit")!;
    expect(() => checkFrame({ ...f, decision: { ...f.decision!, output: null } })).toThrow(/usage limit/);
  });

  it("accepts only a marked self approval under cross-or-self and refuses picking self under cross", () => {
    expect(decision("self-review-cross-or-self", "pickReviewer").output).toEqual({ reviewer: "codex", mode: "self" });
    expect(decision("self-review-cross", "pickReviewer").output).toBeNull();
    const d = decision("self-review-cross-or-self", "acceptedReviewers");
    const { state } = d.input as { state: ReturnType<typeof reviewState> };
    expect(d.output).toEqual(["codex"]);
    expect(state.selfReviewers).toContain("codex");
    expect(acceptedReviewers(state, "codex", "cross")).toEqual([]);
    expect(acceptedReviewers({ ...state, selfReviewers: [] }, "codex", "cross-or-self")).toEqual([]);
    const refused = last("self-review-cross");
    expect(() => checkFrame({ ...refused, decision: { ...refused.decision!, output: { reviewer: "codex", mode: "self" } } })).toThrow(/refused reviewer/);
  });

  it("compensates an ambiguous partial claim back to ready with original routing", () => {
    expect(scenario("claim-compensation").frames.map((f) => f.activeNode)).toEqual(["run.claim", "run.saga", "run.compensate", "state.ready"]);
    expect(last("claim-compensation").decision!.output).toEqual({ kind: "ready" });
    expect(last("claim-compensation").board[0]).toMatchObject({ status: "status:todo", agent: "codex", locked: false, worktree: null });
  });

  it.each(["ready", "claimed", "in-progress", "done"])("repair previews without writing and converges to %s", (kind) => {
    const preview = decision(`repair-${kind}`, "planRepairs").output as RepairPlan;
    expect(preview.state.kind).toBe("inconsistent");
    expect(preview.projectedState.kind).toBe(kind);
    expect(preview.actions.length).toBeGreaterThan(0);
    expect(preview.observation.worktree.kind).toBe("usable"); // original preview observations survived apply
    expect(last(`repair-${kind}`).decision!.output).toEqual({ kind });
    expect(planRepairs(preview.observation)).toEqual(preview);
    const frame = last(`repair-${kind}`);
    const finalFacts = frame.decision!.input as { lock: boolean; worktree: boolean; telemetry: "none" };
    const finalObservation = structuredClone(preview.observation);
    finalObservation.lockOwner = finalFacts.lock ? "demo-owner" : null;
    finalObservation.worktree = finalFacts.worktree ? preview.observation.worktree : { kind: "absent" };
    finalObservation.telemetry = finalFacts.telemetry;
    finalObservation.issue!.labels = [frame.board[0]!.status!];
    expect(planRepairs(finalObservation).actions).toEqual([]);
  });

  it("reports a complete deadlock and preserves both hard dependencies", () => {
    const graph = decision("dependency-deadlock", "buildGraph").output as DepGraph;
    expect(graph.cycles).toEqual([[71, 72]]);
    expect(graph.topoOrder).toEqual([]);
    expect(last("dependency-deadlock").board.map((t) => t.deps)).toEqual([[72], [71]]);
  });

  it("orders eligible After predecessors first and never waits on unavailable ones", () => {
    const order = (id: string) => (decision(id, "orderByAfter").output as Issue[]).map((i) => i.number);
    expect(order("after-eligible")).toEqual([72, 71]);
    expect(order("after-unavailable")).toEqual([71]);
    expect(last("after-unavailable").board[0]).toMatchObject({ deps: [], after: [72] });
  });
});
