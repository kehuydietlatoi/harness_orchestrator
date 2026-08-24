import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type OrchConfig } from "../src/config.js";
import type { Issue } from "../src/github.js";
import { resolveTaskModel } from "../src/runner.js";

function issue(labels: string[] = []): Issue {
  return {
    number: 19,
    title: "Runner honors effort",
    body: "",
    state: "OPEN",
    labels,
    assignees: [],
  };
}

describe("resolveTaskModel", () => {
  it.each([
    ["claude", "easy", "sonnet"],
    ["claude", "hard", "opus"],
    ["codex", "easy", "low"],
    ["codex", "hard", "high"],
  ])("maps %s effort:%s to %s", (agent, tier, expected) => {
    expect(resolveTaskModel(agent, issue([`effort:${tier}`]), DEFAULT_CONFIG)).toBe(expected);
  });

  it("uses the configured default effort when the issue has no effort label", () => {
    const cfg: OrchConfig = { ...DEFAULT_CONFIG, defaultEffort: "easy" };

    expect(resolveTaskModel("claude", issue(), cfg)).toBe("sonnet");
  });

  it("falls back to hard when neither the issue nor config specifies an effort", () => {
    const cfg: OrchConfig = { ...DEFAULT_CONFIG, defaultEffort: undefined };

    expect(resolveTaskModel("claude", issue(), cfg)).toBe("opus");
  });

  it("returns undefined when the agent has no models map", () => {
    const cfg: OrchConfig = {
      ...DEFAULT_CONFIG,
      adapters: { ...DEFAULT_CONFIG.adapters, custom: { cmd: "custom" } },
    };

    expect(resolveTaskModel("custom", issue(["effort:easy"]), cfg)).toBeUndefined();
  });
});
