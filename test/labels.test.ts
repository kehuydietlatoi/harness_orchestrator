import { describe, expect, it } from "vitest";
import { labelDefs } from "../src/github/labels.js";

describe("labelDefs", () => {
  it("resolves canonical names to their definitions, deduped and in order", () => {
    const defs = labelDefs(["effort:lead", "agent:claude", "effort:lead"]);
    expect(defs.map((d) => d.name)).toEqual(["effort:lead", "agent:claude"]);
    const effort = defs.find((d) => d.name === "effort:lead");
    expect(effort?.color).toBeTruthy();
    expect(effort?.description).toBeTruthy();
  });

  it("defaults cosmetics for a name outside the canonical set (e.g. a new agent)", () => {
    expect(labelDefs(["agent:gpt5"])).toEqual([{ name: "agent:gpt5", color: "ededed", description: "" }]);
  });
});

it("defines all four effort labels", () => {
  const tiers = ["free", "cheap", "standard", "lead"].map(t => "effort:" + t);
  const defs = labelDefs(tiers);
  expect(defs.map(d => d.name)).toEqual(tiers);
  expect(defs.every(d => d.description.length > 0)).toBe(true);
});
