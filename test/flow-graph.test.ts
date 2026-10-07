import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deriveTaskState } from "../src/tasks/lifecycle.js";
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
      expect(readFileSync(file!, "utf8").includes(fn!), `${n.id}: ${fn} in ${file}`).toBe(true);
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
    expect(NODES.find((n) => n.id === "plan.goal")!.codeRef).toBe("src/commands/plan.ts#runInteractivePlanner");
  });

  it("models the escalation handoff separately from the needs-attention state", () => {
    expect(outOf("step.escalate")).toEqual(["auto.handoff"]);
    expect(outOf("auto.handoff")).toEqual(["step.none"]);
    expect(STATE_NODES["needs-attention"]).not.toBe("auto.handoff");
    expect(EDGES.some((e) => e.from === "step.escalate" && e.to === "state.needs-attention")).toBe(false);
  });

  it("only reaches done from a merge whose resources were released", () => {
    expect(outOf("review.merge")).toEqual(["review.cleanup"]);
    expect(outOf("review.cleanup").sort()).toEqual(["state.done", "state.inconsistent"]);
    expect(EDGES.filter((e) => e.to === "state.done").map((e) => e.from)).toEqual(["review.cleanup"]);
    expect(outOf("state.inconsistent")).toContain("rec.repair");
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
