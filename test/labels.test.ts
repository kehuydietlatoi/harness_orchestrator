import { describe, expect, it } from "vitest";
import { labelDefs } from "../src/github/labels.js";

describe("labelDefs", () => {
  it("resolves canonical names to their definitions, deduped and in order", () => {
    const defs = labelDefs(["effort:hard", "agent:claude", "effort:hard"]);
    expect(defs.map((d) => d.name)).toEqual(["effort:hard", "agent:claude"]);
    const effort = defs.find((d) => d.name === "effort:hard");
    expect(effort?.color).toBeTruthy();
    expect(effort?.description).toBeTruthy();
  });

  it("defaults cosmetics for a name outside the canonical set (e.g. a new agent)", () => {
    expect(labelDefs(["agent:gpt5"])).toEqual([{ name: "agent:gpt5", color: "ededed", description: "" }]);
  });
});
