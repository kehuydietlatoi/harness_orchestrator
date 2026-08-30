import { describe, expect, it } from "vitest";
import { buildGraph, formatCycle } from "../src/board/graph.js";
import type { Issue } from "../src/github/github.js";

function issue(number: number, deps: number[] = [], over: Partial<Issue> = {}): Issue {
  return {
    number,
    title: `Task ${number}`,
    body: deps.length ? `Do the thing.\nDepends-on: ${deps.map((d) => `#${d}`).join(", ")}` : "Do the thing.",
    state: "OPEN",
    labels: [],
    assignees: [],
    ...over,
  };
}

describe("buildGraph", () => {
  it("produces a topological order for an acyclic graph (deps before dependents)", () => {
    // 3 depends on 2, 2 depends on 1 → order must list 1 before 2 before 3.
    const graph = buildGraph([issue(3, [2]), issue(2, [1]), issue(1)]);
    expect(graph.cycles).toEqual([]);
    expect(graph.nodes).toEqual([1, 2, 3]);
    expect(graph.topoOrder.indexOf(1)).toBeLessThan(graph.topoOrder.indexOf(2));
    expect(graph.topoOrder.indexOf(2)).toBeLessThan(graph.topoOrder.indexOf(3));
    expect(graph.unresolvedDeps).toEqual([]);
  });

  it("handles a diamond (shared dependency) without duplicating nodes", () => {
    // A and B both depend on C; D depends on both A and B.
    const graph = buildGraph([issue(1, [2, 3]), issue(2, [4]), issue(3, [4]), issue(4)]);
    expect(graph.cycles).toEqual([]);
    expect(graph.topoOrder.indexOf(4)).toBeLessThan(graph.topoOrder.indexOf(2));
    expect(graph.topoOrder.indexOf(4)).toBeLessThan(graph.topoOrder.indexOf(3));
    expect(graph.topoOrder.indexOf(2)).toBeLessThan(graph.topoOrder.indexOf(1));
  });

  it("detects a 3-node cycle and reports an ordered path", () => {
    // 1→2→3→1
    const graph = buildGraph([issue(1, [2]), issue(2, [3]), issue(3, [1])]);
    expect(graph.topoOrder).toEqual([]);
    expect(graph.cycles).toHaveLength(1);
    expect(graph.cycles[0]).toEqual([1, 2, 3]);
    expect(formatCycle(graph.cycles[0])).toBe("#1 → #2 → #3 → #1");
  });

  it("detects a self-dependency as a cycle", () => {
    const graph = buildGraph([issue(5, [5])]);
    expect(graph.cycles).toEqual([[5]]);
    expect(formatCycle(graph.cycles[0])).toBe("#5 → #5");
  });

  it("reports two independent cycles, sorted by lowest member", () => {
    const graph = buildGraph([
      issue(1, [2]),
      issue(2, [1]),
      issue(10, [11]),
      issue(11, [10]),
    ]);
    expect(graph.cycles).toEqual([
      [1, 2],
      [10, 11],
    ]);
  });

  it("does not treat a dep on a closed issue as a blocking edge or a cycle", () => {
    // 1 depends on 2 which is CLOSED; 2 'depends on' 1 but is closed so no edge.
    const graph = buildGraph([issue(1, [2]), issue(2, [1], { state: "CLOSED" })]);
    expect(graph.nodes).toEqual([1]);
    expect(graph.edges).toEqual([]);
    expect(graph.cycles).toEqual([]);
    expect(graph.unresolvedDeps).toEqual([{ issue: 1, dep: 2 }]);
  });

  it("reports a dep on a nonexistent issue as unresolved, not an edge", () => {
    const graph = buildGraph([issue(1, [99])]);
    expect(graph.edges).toEqual([]);
    expect(graph.cycles).toEqual([]);
    expect(graph.unresolvedDeps).toEqual([{ issue: 1, dep: 99 }]);
  });

  it("is empty and safe for an empty board", () => {
    const graph = buildGraph([]);
    expect(graph).toEqual({ nodes: [], edges: [], cycles: [], unresolvedDeps: [], topoOrder: [] });
  });
});
