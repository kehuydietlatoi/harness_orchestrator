import type { Issue } from "../github/github.js";
import { parseDeps } from "./board.js";

/** A blocking dependency edge among open issues: `from` depends on `to`. */
export interface GraphEdge {
  from: number;
  to: number;
}

/** A dependency pointing at an issue that is not among the open issues (closed or missing). */
export interface UnresolvedDep {
  issue: number;
  dep: number;
}

/**
 * The dependency DAG derived from open issues. This is a pure projection of the
 * `Depends-on:` bodies — GitHub issues remain the source of truth; nothing here
 * is persisted. `edges` are the *blocking* edges only (both endpoints open),
 * matching `openDepsFromMap` semantics: a dep on a closed/missing issue never
 * blocks, so it is reported in `unresolvedDeps` instead of forming an edge.
 *
 * When the graph is acyclic, `cycles` is empty and `topoOrder` lists every node.
 * When any cycle exists the board is (partially) deadlocked, so `topoOrder` is
 * empty and each deadlocked group is reported in `cycles`.
 */
export interface DepGraph {
  /** Open issue numbers, ascending. */
  nodes: number[];
  /** Blocking edges among open nodes (`from` depends on `to`). */
  edges: GraphEdge[];
  /** One ordered path per deadlocked group; `[a, b, c]` means a→b→c→a. */
  cycles: number[][];
  /** Deps pointing outside the open set (closed or nonexistent issues). */
  unresolvedDeps: UnresolvedDep[];
  /** Topological order of the open nodes; empty when a cycle exists. */
  topoOrder: number[];
}

/**
 * Build the dependency DAG from a list of open issues. Pure and deterministic:
 * nodes, edges, cycles, and unresolved deps are all sorted so callers (runtime
 * guard, `orch doctor`, dashboard) render identically.
 */
export function buildGraph(issues: readonly Issue[]): DepGraph {
  const open = new Set<number>();
  for (const issue of issues) {
    if (issue.state.toUpperCase() !== "CLOSED") open.add(issue.number);
  }
  const nodes = [...open].sort((a, b) => a - b);

  const adj = new Map<number, number[]>();
  for (const n of nodes) adj.set(n, []);

  const edges: GraphEdge[] = [];
  const unresolvedDeps: UnresolvedDep[] = [];
  for (const issue of issues) {
    if (!open.has(issue.number)) continue;
    for (const dep of parseDeps(issue.body)) {
      if (open.has(dep)) {
        edges.push({ from: issue.number, to: dep });
        adj.get(issue.number)!.push(dep);
      } else {
        unresolvedDeps.push({ issue: issue.number, dep });
      }
    }
  }
  edges.sort((a, b) => a.from - b.from || a.to - b.to);
  unresolvedDeps.sort((a, b) => a.issue - b.issue || a.dep - b.dep);
  for (const [, out] of adj) out.sort((a, b) => a - b);

  const cycles = findCycles(nodes, adj);
  const topoOrder = cycles.length > 0 ? [] : topoSort(nodes, adj);

  return { nodes, edges, cycles, unresolvedDeps, topoOrder };
}

/** Kahn's algorithm over the blocking subgraph. Assumes the graph is acyclic. */
function topoSort(nodes: readonly number[], adj: Map<number, number[]>): number[] {
  // Edge u→v ("u depends on v") means v must come first. Order dependencies
  // before dependents by counting each node's dependents (reverse in-degree).
  const dependents = new Map<number, number>();
  for (const n of nodes) dependents.set(n, 0);
  for (const n of nodes) {
    for (const dep of adj.get(n) ?? []) dependents.set(dep, (dependents.get(dep) ?? 0) + 1);
  }
  const ready = nodes.filter((n) => (dependents.get(n) ?? 0) === 0).sort((a, b) => a - b);
  const order: number[] = [];
  // Process leaves-first, then reverse so dependencies precede dependents.
  while (ready.length > 0) {
    const n = ready.shift()!;
    order.push(n);
    for (const dep of adj.get(n) ?? []) {
      const next = (dependents.get(dep) ?? 0) - 1;
      dependents.set(dep, next);
      if (next === 0) {
        // insert keeping ascending order for determinism
        let i = ready.length;
        while (i > 0 && ready[i - 1] > dep) i--;
        ready.splice(i, 0, dep);
      }
    }
  }
  return order.reverse();
}

/**
 * Every deadlocked group, as an ordered cycle path. Uses Tarjan's SCC to group
 * mutually-reachable nodes, then extracts one representative cycle path per
 * nontrivial component (or a self-loop) so the report reads `a→b→c→a`.
 */
function findCycles(nodes: readonly number[], adj: Map<number, number[]>): number[][] {
  const index = new Map<number, number>();
  const low = new Map<number, number>();
  const onStack = new Set<number>();
  const stack: number[] = [];
  const sccs: number[][] = [];
  let counter = 0;

  const strongconnect = (v: number): void => {
    index.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!index.has(w)) {
        strongconnect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      const component: number[] = [];
      let w: number;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      sccs.push(component);
    }
  };

  for (const n of nodes) {
    if (!index.has(n)) strongconnect(n);
  }

  const cycles: number[][] = [];
  for (const component of sccs) {
    const members = new Set(component);
    const selfLoop = component.length === 1 && (adj.get(component[0]) ?? []).includes(component[0]);
    if (component.length > 1 || selfLoop) {
      cycles.push(cyclePath(members, adj));
    }
  }
  return cycles.sort((a, b) => a[0] - b[0]);
}

/** One cycle path through a strongly-connected group, starting at its lowest node. */
function cyclePath(scc: Set<number>, adj: Map<number, number[]>): number[] {
  const start = Math.min(...scc);
  const path: number[] = [];
  const onPath = new Set<number>();
  const visited = new Set<number>();
  let result: number[] | null = null;

  const dfs = (u: number): boolean => {
    path.push(u);
    onPath.add(u);
    for (const v of adj.get(u) ?? []) {
      if (!scc.has(v)) continue;
      if (onPath.has(v)) {
        result = path.slice(path.indexOf(v));
        return true;
      }
      if (!visited.has(v) && dfs(v)) return true;
    }
    path.pop();
    onPath.delete(u);
    visited.add(u);
    return false;
  };

  dfs(start);
  return result ?? [start];
}

/** Render a cycle path as `#a → #b → #c → #a` for human-facing messages. */
export function formatCycle(cycle: number[]): string {
  return [...cycle, cycle[0]].map((n) => `#${n}`).join(" → ");
}
