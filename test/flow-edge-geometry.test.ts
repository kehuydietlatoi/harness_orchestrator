import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EDGES } from "../src/demo/flow-graph.js";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const block = /\/\/ BEGIN flow-edge-geometry[^\n]*\n([\s\S]*?)\/\/ END flow-edge-geometry/.exec(html)?.[1];
const { flowEdgeSlots, flowEdgePath } = new Function(
  `${block}\nreturn { flowEdgeSlots, flowEdgePath };`,
)() as {
  flowEdgeSlots: (edges: { id: string; from: string; to: string }[]) => Map<string, { index: number; offset: number }>;
  flowEdgePath: (s: { x: number; y: number }, e: { x: number; y: number }, o: number) => { d: string; lx: number; ly: number };
};

describe("flow graph parallel edges", () => {
  it.each([["plan.gate", "plan.hint"], ["auto.decide", "step.fix"]])("separates %s -> %s", (from, to) => {
    const pair = EDGES.filter((e) => e.from === from && e.to === to);
    expect(pair).toHaveLength(2);
    const slots = flowEdgeSlots(EDGES);
    const start = { x: 0, y: 0 };
    const end = { x: 200, y: 0 };
    const paths = pair.map((e) => flowEdgePath(start, end, slots.get(e.id)!.offset));
    expect(paths[0].d).not.toBe(paths[1].d);
    expect(Math.hypot(paths[0].lx - paths[1].lx, paths[0].ly - paths[1].ly)).toBeGreaterThan(20);
  });

  it("keeps a lone edge straight", () => {
    const only = EDGES.find((e) => e.from === "auto.decide" && e.to === "step.merge")!;
    expect(flowEdgeSlots(EDGES).get(only.id)!.offset).toBe(0);
  });
});
