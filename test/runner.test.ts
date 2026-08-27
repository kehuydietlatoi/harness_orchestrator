import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type OrchConfig } from "../src/config.js";
import type { Issue } from "../src/github/github.js";
import { resolveDispatchAgent, resolveTaskModel } from "../src/tasks/runner.js";

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

describe("resolveDispatchAgent", () => {
  it("returns the routed configured agent for an unblocked todo", () => {
    const target = issue(["status:todo", "agent:codex"]);
    expect(resolveDispatchAgent(target, new Map([[target.number, target]]), DEFAULT_CONFIG)).toBe("codex");
  });

  it("rejects unrouted, non-todo, unknown-agent, and blocked issues", () => {
    const unrouted = issue(["status:todo"]);
    expect(() => resolveDispatchAgent(unrouted, new Map([[19, unrouted]]), DEFAULT_CONFIG)).toThrow(/not routed/);

    const active = issue(["status:in-progress", "agent:codex"]);
    expect(() => resolveDispatchAgent(active, new Map([[19, active]]), DEFAULT_CONFIG)).toThrow(/not a todo/);

    const unknown = issue(["status:todo", "agent:other"]);
    expect(() => resolveDispatchAgent(unknown, new Map([[19, unknown]]), DEFAULT_CONFIG)).toThrow(/unknown agent/);

    const blocked = { ...issue(["status:todo", "agent:codex"]), body: "Depends-on: #7" };
    const dep = { ...issue(), number: 7 };
    expect(() => resolveDispatchAgent(blocked, new Map([[19, blocked], [7, dep]]), DEFAULT_CONFIG)).toThrow(
      /blocked by.*#7/,
    );
  });
});
