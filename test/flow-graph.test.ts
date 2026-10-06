import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
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
