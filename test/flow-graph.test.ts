import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deriveTaskState } from "../src/tasks/lifecycle.js";
import { planRepairs } from "../src/tasks/reconcile.js";
import { EDGES, FLOWS, NODES, STATE_NODES, STEP_NODES } from "../src/demo/flow-graph.js";

const ids = new Set(NODES.map((n) => n.id));

describe("flow graph model", () => {
  it("has unique node, edge and flow ids", () => {
    expect(ids.size).toBe(NODES.length);
    expect(new Set(EDGES.map((e) => e.id)).size).toBe(EDGES.length);
    expect(new Set(FLOWS.map((f) => f.id)).size).toBe(FLOWS.length);
  });

  it("only connects nodes that exist", () => {
    for (const e of EDGES) {
      expect(ids.has(e.from), `${e.id} from`).toBe(true);
      expect(ids.has(e.to), `${e.id} to`).toBe(true);
    }
  });

  it("puts every edge in a defined flow and every flow on an edge", () => {
    const flowIds = new Set(FLOWS.map((f) => f.id));
    for (const e of EDGES) {
      expect(e.flows.length, e.id).toBeGreaterThan(0);
      for (const f of e.flows) expect(flowIds.has(f), `${e.id} -> ${f}`).toBe(true);
    }
    for (const f of FLOWS) expect(EDGES.some((e) => e.flows.includes(f.id)), f.id).toBe(true);
  });

  it("maps every autopilot step and lifecycle state to a node", () => {
    for (const id of [...Object.values(STEP_NODES), ...Object.values(STATE_NODES)]) expect(ids.has(id), id).toBe(true);
  });

  it("leaves no node unconnected", () => {
    const used = new Set(EDGES.flatMap((e) => [e.from, e.to]));
    for (const n of NODES) expect(used.has(n.id), n.id).toBe(true);
  });

  it("points every codeRef at a real file and function", () => {
    for (const n of NODES) {
      const [file, fn] = n.codeRef.split("#");
      expect(existsSync(file!), `${n.id}: ${file}`).toBe(true);
      const def = new RegExp(String.raw`(function\*?|const|let|class)\s+${fn}\b|^\s*(async\s+)?${fn}\s*\(`, "m");
      expect(def.test(readFileSync(file!, "utf8")), `${n.id}: ${fn} is not defined in ${file}`).toBe(true);
    }
  });

  it("gives every node a distinct position", () => {
    expect(new Set(NODES.map((n) => `${n.x},${n.y}`)).size).toBe(NODES.length);
  });
});

describe("flow graph regressions", () => {
  const outOf = (from: string) => EDGES.filter((e) => e.from === from).map((e) => e.to);

  it("sends a triage retry back to observation, never straight to a push", () => {
    expect(outOf("step.triage")).toContain("auto.observe");
    expect(outOf("step.triage")).not.toContain("auto.push");
  });

  it("routes failed and no-commit runs through cleanup to their derived states", () => {
    expect(outOf("run.fail")).toEqual(["run.cleanup"]);
    expect(outOf("run.nocommit")).toEqual(["run.cleanup"]);
    expect(outOf("run.cleanup").sort()).toEqual(["state.inconsistent", "state.needs-attention"]);
    expect(outOf("state.needs-attention")).toContain("rec.repair");
    expect(outOf("state.inconsistent")).toContain("rec.repair");
  });

  it("keeps abandon outcomes separate from failed-run cleanup", () => {
    const abandon = EDGES.filter((e) => e.from === "rec.safe" || e.from === "rec.abandon");
    for (const e of abandon) expect(e.flows).not.toContain("failure-recovery");
    expect(EDGES.some((e) => e.from === "run.fail" && e.to === "rec.safe")).toBe(false);
  });

  it("never treats abandon cleanup as ready by itself: the lifecycle is re-derived from facts", () => {
    expect(outOf("rec.safe")).not.toContain("state.ready");
    expect(outOf("rec.discard")).not.toContain("state.ready");
    expect(outOf("rec.todo").sort()).toEqual(["state.needs-attention", "state.ready"]);
    const released = { issue: "open", lock: false, worktree: false, pr: "none" } as const;
    // Abandon releases the resources but keeps failure telemetry and any task branch.
    expect(deriveTaskState({ ...released, branch: "absent", telemetry: "failed" }).kind).toBe("needs-attention");
    expect(deriveTaskState({ ...released, branch: "ahead", telemetry: "none" }).kind).toBe("needs-attention");
    expect(deriveTaskState({ ...released, branch: "absent", telemetry: "none" }).kind).toBe("ready");
  });
});

describe("flow graph review-round regressions", () => {
  const outOf = (from: string) => EDGES.filter((e) => e.from === from).map((e) => e.to);

  it("validates the plan before the approval gate and sends declines to the hint", () => {
    expect(outOf("plan.goal")).toEqual(["plan.resolve"]);
    expect(outOf("plan.resolve").sort()).toEqual(["plan.blocked", "plan.gate"]);
    expect(outOf("plan.gate")).not.toContain("plan.resolve");
    expect(EDGES.filter((e) => e.from === "plan.gate" && e.to === "plan.hint").map((e) => e.label)).toEqual([
      "no TTY, no --yes: hint",
      "declined (n): hint",
    ]);
    expect(NODES.find((n) => n.id === "plan.goal")!.codeRef).toBe("src/tasks/planner.ts#runInteractivePlanner");
  });

  it("models the escalation handoff separately from the needs-attention state", () => {
    expect(outOf("step.escalate")).toEqual(["auto.handoff"]);
    expect(outOf("auto.handoff")).toEqual(["step.none"]);
    expect(STATE_NODES["needs-attention"]).not.toBe("auto.handoff");
    expect(EDGES.some((e) => e.from === "step.escalate" && e.to === "state.needs-attention")).toBe(false);
  });

  it("reaches done only once resources are released: after a merge's cleanup, or a repair that finishes it", () => {
    expect(outOf("review.merge")).toEqual(["review.cleanup"]);
    expect(outOf("review.cleanup").sort()).toEqual(["state.done", "state.inconsistent"]);
    expect(EDGES.filter((e) => e.to === "state.done").map((e) => e.from).sort()).toEqual(["rec.derive", "review.cleanup"]);
    expect(outOf("state.inconsistent")).toContain("rec.repair");
  });

  it("lets a repair land in any lifecycle state, since it re-derives after its actions", () => {
    expect(new Set(outOf("rec.derive"))).toEqual(new Set(Object.values(STATE_NODES)));
  });

  it("repairs a merged task with retained resources to done, not ready", () => {
    const branch = "task/36-x";
    const plan = planRepairs({
      number: 36,
      issue: { number: 36, title: "x", body: "", state: "OPEN", labels: ["status:in-review"], assignees: [] },
      expectedBranch: branch,
      lockOwner: "owner-token",
      worktree: { kind: "usable", path: "/wt/issue-36", branch, removable: true },
      branch: "ahead",
      prs: [{ number: 136, title: "x", body: "Closes #36", headRefName: branch, state: "MERGED", htmlUrl: "", headSha: "a".repeat(40) }],
      reviews: [],
      telemetry: "submitted",
    });
    expect(plan.actions.map((a) => a.kind)).toEqual(expect.arrayContaining(["close-issue", "safe-remove-worktree", "release-lock"]));
    expect(plan.projectedState.kind).toBe("done");
    expect(EDGES.some((e) => e.from === "rec.derive" && e.to === STATE_NODES.done)).toBe(true);
  });

  it("models every claim-compensation outcome: released, rolled forward, or ownership retained", () => {
    expect(outOf("run.compensate").sort()).toEqual(["rec.retained", "state.claimed", "state.ready"]);
    expect(EDGES.find((e) => e.from === "run.compensate" && e.to === "state.claimed")?.label).toMatch(/proven/);
  });
});

describe("review.changes follows deriveTaskState", () => {
  const open = { issue: "open", lock: true, worktree: true, branch: "ahead", pr: "open", telemetry: "submitted" } as const;

  it("derives in-progress for an open PR with changes requested, in-review otherwise", () => {
    expect(deriveTaskState({ ...open, changesRequested: true }).kind).toBe("in-progress");
    expect(deriveTaskState(open).kind).toBe("in-review");
    const e = EDGES.find((edge) => edge.from === "review.changes")!;
    expect(e.to).toBe("state.in-progress");
  });

  it("does not describe in-review by its review:needed label", () => {
    expect(NODES.find((n) => n.id === "state.in-review")!.summary).not.toContain("review:needed");
  });
});

describe("requeue guard and advisory routing", () => {
  const from = (id: string) => EDGES.filter((e) => e.from === id);

  it("models both outcomes of the requeue guard", () => {
    const requeue = from("run.usage").find((e) => e.to === "run.requeue")!;
    const fail = from("run.usage").find((e) => e.to === "run.fail")!;
    expect(requeue.label).toMatch(/no commits.*no open PR.*worktree removed.*lock released/);
    expect(fail.label).toMatch(/commits ahead/);
    expect(fail.label).toMatch(/open PR/);
    expect(fail.label).toMatch(/worktree retained/);
    expect(fail.label).toMatch(/lock not released/);
  });

  it("treats plan evaluation as advisory and applies valid entries while skipping invalid ones", () => {
    expect(NODES.find((n) => n.id === "route.eval")!.kind).toBe("stage");
    expect(NODES.find((n) => n.id === "route.apply")!.kind).toBe("decision");
    expect(from("route.eval").map((e) => e.to)).toEqual(["route.apply"]);
    expect(from("route.eval")[0]!.label).toMatch(/never blocks/);
    expect(from("route.apply").map((e) => e.to).sort()).toEqual(["route.skipped", "state.ready"]);
    for (const e of from("route.apply")) expect(e.flows).toContain("routing");
  });
});
