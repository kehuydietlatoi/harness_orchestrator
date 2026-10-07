import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderFlows } from "../scripts/gen-flows.js";
import { EDGES, FLOWS } from "../src/demo/flow-graph.js";
import { SCENARIOS } from "../src/demo/scenarios/index.js";

describe("flow documentation and scenario coverage", () => {
  it("visits exactly every modeled edge across the scenario registry", () => {
    const visited = new Set(SCENARIOS.flatMap((scenario) => scenario.frames.flatMap((frame) => frame.edge ? [frame.edge] : [])));
    expect([...visited].sort()).toEqual(EDGES.map((edge) => edge.id).sort());
  });

  it("demonstrates every flow with at least one scenario that visits its edges", () => {
    for (const flow of FLOWS) {
      const edges = new Set(EDGES.filter((edge) => edge.flows.includes(flow.id)).map((edge) => edge.id));
      const demonstrating = SCENARIOS.filter((scenario) => scenario.flows.includes(flow.id)
        && scenario.frames.some((frame) => frame.edge && edges.has(frame.edge)));
      expect(demonstrating.length, `uncovered flow: ${flow.id}`).toBeGreaterThan(0);
    }
  });

  it("matches the checked-in FLOWS.md (regenerate with npm run docs:flows)", () => {
    expect(renderFlows()).toBe(readFileSync(new URL("../docs/FLOWS.md", import.meta.url), "utf8"));
  });
});
