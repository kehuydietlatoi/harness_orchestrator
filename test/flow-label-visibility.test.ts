import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const block = /\/\/ BEGIN flow-label-visibility[^\n]*\n([\s\S]*?)\/\/ END flow-label-visibility/.exec(html)?.[1];
const flowLabelVisible = new Function(`${block}\nreturn flowLabelVisible;`)() as (input: {
  edge: { id: string; from: string; to: string; flows: string[] };
  filter: string;
  activeEdge: string | null;
  selected: string | null;
}) => boolean;

const edge = { id: "edge-a", from: "node-a", to: "node-b", flows: ["plan", "review"] };
const idle = { edge, filter: "", activeEdge: null, selected: null };

describe("flow label visibility", () => {
  it("hides labels with no filter, active edge or selection", () => {
    expect(flowLabelVisible(idle)).toBe(false);
  });

  it.each(["plan", "review"])("shows an edge in the filtered %s flow", (filter) => {
    expect(flowLabelVisible({ ...idle, filter })).toBe(true);
    expect(flowLabelVisible({ ...idle, filter: "unrelated" })).toBe(false);
  });

  it("shows only the active edge", () => {
    expect(flowLabelVisible({ ...idle, activeEdge: edge.id })).toBe(true);
    expect(flowLabelVisible({ ...idle, activeEdge: "edge-other" })).toBe(false);
  });

  it.each([edge.from, edge.to])("shows edges incident to selected node %s", (selected) => {
    expect(flowLabelVisible({ ...idle, selected })).toBe(true);
    expect(flowLabelVisible({ ...idle, selected: "node-other" })).toBe(false);
  });

  it("keeps active and incident labels visible outside the filtered flow", () => {
    expect(flowLabelVisible({ ...idle, filter: "unrelated", activeEdge: edge.id })).toBe(true);
    expect(flowLabelVisible({ ...idle, filter: "unrelated", selected: edge.to })).toBe(true);
  });
});
