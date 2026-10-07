import { describe, expect, it } from "vitest";
import { EDGES, LANES, NODES } from "../src/demo/flow-graph.js";
import type { FlowEdge, FlowNode } from "../src/demo/flow-graph.js";
import { NODE_H, NODE_W, layoutFlow, layoutViolations, wrapLabel } from "../src/demo/flow-layout.js";
import type { FlowLayout, FlowModel, ViolationKind } from "../src/demo/flow-layout.js";

const real: FlowModel = { lanes: LANES, nodes: NODES, edges: EDGES };

const n = (id: string, x: number, y: number): FlowNode => ({
  id, label: id, kind: "stage", lane: "plan", x, y, codeRef: "x#y", summary: "",
});
const e = (id: string, from: string, to: string, ...flows: FlowEdge["flows"]): FlowEdge => ({
  id, from, to, label: id, flows,
});
const lane = { id: "plan" as const, label: "Plan", y: 0, height: 300 };

/** A clean hand-built layout that each test then breaks in one way. */
function base(): { model: FlowModel; layout: FlowLayout } {
  const model: FlowModel = {
    lanes: [lane],
    nodes: [n("a", 100, 100), n("b", 400, 100), n("c", 700, 100)],
    edges: [e("ab", "a", "b", "plan-pipeline"), e("bc", "b", "c", "routing")],
  };
  const label = (x: number, y: number) => ({ x, y, w: 40, h: 18, lines: ["x"] });
  const layout: FlowLayout = {
    width: 900,
    height: 300,
    lanes: [{ id: "plan", y: 0, height: 300 }],
    routes: {
      ab: { points: [{ x: 175, y: 100 }, { x: 325, y: 100 }], label: label(250, 100) },
      bc: { points: [{ x: 475, y: 100 }, { x: 625, y: 100 }], label: label(550, 100) },
    },
  };
  return { model, layout };
}

const kinds = (m: FlowModel, l: FlowLayout): ViolationKind[] => layoutViolations(m, l).map((v) => v.kind);

describe("layoutFlow on the real model", () => {
  const layout = layoutFlow(real);

  it("has no layout violations", () => {
    expect(layoutViolations(real, layout)).toEqual([]);
  });

  it("routes every edge and is deterministic", () => {
    expect(Object.keys(layout.routes).sort()).toEqual(EDGES.map((x) => x.id).sort());
    expect(layoutFlow(real)).toEqual(layout);
  });

  it("emits orthogonal routes and lanes that match the model", () => {
    for (const r of Object.values(layout.routes)) {
      for (let i = 1; i < r.points.length; i++) {
        const a = r.points[i - 1]!;
        const b = r.points[i]!;
        expect(a.x === b.x || a.y === b.y).toBe(true);
      }
    }
    expect(layout.lanes).toEqual(LANES.map((l) => ({ id: l.id, y: l.y, height: l.height })));
  });

  it("derives lane height from the deepest row", () => {
    for (const l of LANES) {
      const bottom = Math.max(...NODES.filter((x) => x.lane === l.id).map((x) => x.y + NODE_H / 2));
      expect(l.y + l.height).toBeGreaterThan(bottom);
    }
  });
});

describe("layoutViolations is not vacuous", () => {
  it("accepts the clean base layout", () => {
    const { model, layout } = base();
    expect(layoutViolations(model, layout)).toEqual([]);
  });

  it("node-overlap", () => {
    const { model, layout } = base();
    model.nodes = [n("a", 100, 100), n("b", 100 + NODE_W + 10, 100), n("c", 700, 100)];
    expect(kinds(model, layout)).toContain("node-overlap");
  });

  it("node-outside-lane", () => {
    const { model, layout } = base();
    layout.lanes = [{ id: "plan", y: 0, height: 110 }];
    expect(kinds(model, layout)).toContain("node-outside-lane");
  });

  it("route-through-node", () => {
    const { model, layout } = base();
    layout.routes.ab!.points = [{ x: 175, y: 100 }, { x: 325, y: 100 }, { x: 325, y: 200 }];
    model.nodes = [n("a", 100, 100), n("b", 400, 100), n("c", 250, 100)];
    expect(kinds(model, layout)).toContain("route-through-node");
  });

  it("route-endpoint", () => {
    const { model, layout } = base();
    layout.routes.ab!.points = [{ x: 100, y: 100 }, { x: 325, y: 100 }];
    expect(kinds(model, layout)).toContain("route-endpoint");
  });

  it("label-on-node", () => {
    const { model, layout } = base();
    layout.routes.ab!.label.x = 400;
    expect(kinds(model, layout)).toContain("label-on-node");
  });

  it("label-overlap-in-flow", () => {
    const { model, layout } = base();
    model.edges = [e("ab", "a", "b", "routing"), e("bc", "b", "c", "routing")];
    layout.routes.bc!.label.x = 250;
    layout.routes.bc!.label.y = 100;
    expect(kinds(model, layout)).toContain("label-overlap-in-flow");
  });

  it("label-overlap-at-node", () => {
    const { model, layout } = base();
    layout.routes.bc!.label.x = 250;
    expect(kinds(model, layout)).toContain("label-overlap-at-node");
    expect(kinds(model, layout)).not.toContain("label-overlap-in-flow");
  });

  it("out-of-bounds", () => {
    const { model, layout } = base();
    layout.routes.ab!.label.y = -50;
    expect(kinds(model, layout)).toContain("out-of-bounds");
  });
});

describe("wrapLabel", () => {
  it("wraps long text and keeps short text on one line", () => {
    expect(wrapLabel("short")).toEqual(["short"]);
    expect(wrapLabel("a ".repeat(60)).length).toBeGreaterThan(1);
  });
});
