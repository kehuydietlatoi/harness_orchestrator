import { describe, expect, it, vi } from "vitest";
import { checkFrame, checkScenario, resolveEdge, ScenarioDriftError, type Frame } from "../src/demo/scenario-engine.js";
import { EDGES, FLOWS, NODES } from "../src/demo/flow-graph.js";
import { SCENARIOS } from "../src/demo/scenarios/index.js";

const nodeIds = new Set(NODES.map((n) => n.id));
const edges = new Map(EDGES.map((e) => [e.id, e]));
const flowIds = new Set(FLOWS.map((f) => f.id));

describe("scenario registry", () => {
  it("has unique scenario and frame ids and only known flows", () => {
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
    const frames = SCENARIOS.flatMap((s) => s.frames.map((f) => f.id));
    expect(new Set(frames).size).toBe(frames.length);
    for (const s of SCENARIOS) for (const f of s.flows) expect(flowIds.has(f), `${s.id} -> ${f}`).toBe(true);
  });

  it.each(SCENARIOS.map((s) => [s.id, s] as const))("%s passes the drift check", (_id, scenario) => {
    expect(() => checkScenario(scenario)).not.toThrow();
  });

  it("only uses nodes and edges that exist, and moves along declared edges", () => {
    for (const s of SCENARIOS) {
      s.frames.forEach((f, i) => {
        expect(nodeIds.has(f.activeNode), f.id).toBe(true);
        if (!f.edge) return;
        const e = edges.get(f.edge);
        expect(e, `${f.id}: ${f.edge}`).toBeDefined();
        expect(e!.to, f.id).toBe(f.activeNode);
        if (i > 0) expect(e!.from, f.id).toBe(s.frames[i - 1]!.activeNode);
      });
    }
  });

  it("is deterministic: rebuilding the scenarios yields identical frames", async () => {
    vi.resetModules();
    const again = (await import("../src/demo/scenarios/index.js")).SCENARIOS;
    expect(again).not.toBe(SCENARIOS);
    expect(JSON.stringify(again)).toBe(JSON.stringify(SCENARIOS));
  });

  it("matches the frame id/edge snapshot", () => {
    expect(SCENARIOS.map((s) => ({ id: s.id, frames: s.frames.map((f) => `${f.id} ${f.activeNode} <- ${f.edge ?? "cut"}`) }))).toMatchSnapshot();
  });
});

describe("drift check", () => {
  const happy = SCENARIOS.find((s) => s.id === "happy-path")!;
  const frameWith = (fn: string): Frame => happy.frames.find((f) => f.decision?.fn === fn && f.edge)!;

  it("throws when a decider's output no longer leads along the scripted edge", () => {
    const merge = frameWith("evaluateGate");
    const drifted: Frame = { ...merge, decision: { ...merge.decision!, output: ["CI not green: failing"] } };
    expect(() => checkFrame(drifted)).toThrow(ScenarioDriftError);
  });

  it("throws on a decider with no registered check, an unknown edge, or a broken chain", () => {
    const f = frameWith("evaluateGate");
    expect(() => checkFrame({ ...f, decision: { fn: "mystery", input: null, output: null } })).toThrow(/no drift check/);
    expect(() => checkFrame({ ...f, edge: "nope>nope:x" })).toThrow(/unknown edge/);
    const frames = [...happy.frames];
    frames.splice(3, 1);
    expect(() => checkScenario({ ...happy, frames })).toThrow(/walk was at/);
  });

  it("rejects an edge reference that is ambiguous or missing", () => {
    expect(() => resolveEdge(["plan.gate", "plan.hint"])).toThrow(/2 edges/);
    expect(() => resolveEdge(["plan.gate", "state.done"])).toThrow(/0 edges/);
  });
});
