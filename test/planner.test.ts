import { describe, expect, it } from "vitest";
import {
  extractTickets,
  formatInteractiveSeed,
  formatPlanPrompt,
  runInteractivePlanner,
  runPlanner,
  type PlannerRunner,
} from "../src/tasks/planner.js";
import { DEFAULT_CONFIG, type OrchConfig } from "../src/config.js";
import { makeAdapter } from "../src/adapters/index.js";

const cfg = DEFAULT_CONFIG;
const adapterFixtures: Array<[string, OrchConfig]> = [
  ["Claude", { ...DEFAULT_CONFIG, lead: "claude" }],
  ["Codex", { ...DEFAULT_CONFIG, lead: "codex" }],
];

function runnerReturning(run: Partial<{ code: number; timedOut: boolean; text: string; raw: string }>): PlannerRunner {
  return async () => ({ code: 0, timedOut: false, text: "", raw: "", ...run });
}

describe("formatPlanPrompt", () => {
  it("embeds the skill, the goal, optional context, and the output reminder", () => {
    const p = formatPlanPrompt("SKILL-BODY", "add SSO", "Repository files:\nsrc/a.ts");
    expect(p).toContain("SKILL-BODY");
    expect(p).toContain("add SSO");
    expect(p).toContain("=== GOAL ===");
    expect(p).toContain("Repository files:");
    expect(p).toContain("fenced code block tagged json"); // the output reminder
    expect(p).toContain("dependsOn");
  });

  it("omits the context section when none is given", () => {
    expect(formatPlanPrompt("S", "g")).not.toContain("REPO CONTEXT");
  });
});

describe("extractTickets", () => {
  it("parses the last fenced json array of tickets, tolerating prose", () => {
    const text = 'here you go:\n```json\n[{"id":"a","title":"First"},{"title":"Second","dependsOn":["a"]}]\n```';
    const tickets = extractTickets(text);
    expect(tickets.map((t) => t.title)).toEqual(["First", "Second"]);
    expect(tickets[1].dependsOn).toEqual(["a"]);
  });

  it("throws when there is no fenced block", () => {
    expect(() => extractTickets("no block here")).toThrow(/no fenced/i);
  });

  it("throws when the block is not a JSON array", () => {
    expect(() => extractTickets('```json\n{"title":"x"}\n```')).toThrow(/must be a JSON array/i);
  });
});

describe("interactive planning builders", () => {
  it("formatInteractiveSeed embeds the output path + Write instruction as one safe line", () => {
    const seed = formatInteractiveSeed("/abs/tickets.json");
    expect(seed).toContain("/abs/tickets.json");
    expect(seed).toContain("Write");
    expect(seed).toContain("orch-plan skill");
    // Must survive argv shell-quoting: single line, no double-quotes or backticks.
    expect(seed).not.toContain("\n");
    expect(seed).not.toContain('"');
    expect(seed).not.toContain("`");
  });

  it("dispatches through an adapter's interactive-planning capability", async () => {
    const adapter = makeAdapter("claude", cfg);
    let seenSeed = "";
    adapter.runInteractivePlan = async (ctx) => {
      seenSeed = ctx.seed;
      return { code: 7 };
    };
    await expect(runInteractivePlanner(adapter, { cwd: ".", seed: "SEED", model: "opus" })).resolves.toEqual({
      code: 7,
    });
    expect(seenSeed).toBe("SEED");
  });

  it("fails precisely when the lead adapter does not support interactive planning", () => {
    const adapter = makeAdapter("codex", cfg);
    expect(() => runInteractivePlanner(adapter, { cwd: ".", seed: "SEED", model: "high" })).toThrow(
      'lead adapter \'codex\' does not support interactive planning; use `orch plan --draft "<goal>"` instead',
    );
  });
});

describe("runPlanner (fail-closed)", () => {
  const goal = "goal";
  const skill = "skill";

  it.each(adapterFixtures)("returns the parsed tickets with the %s lead fixture", async (_name, fixtureCfg) => {
    const runner = runnerReturning({ text: '```json\n[{"id":"a","title":"First"}]\n```' });
    await expect(runPlanner(goal, skill, "", fixtureCfg, ".", runner)).resolves.toEqual([
      { id: "a", title: "First", body: undefined, dependsOn: undefined, files: undefined },
    ]);
  });

  it("throws on a non-zero exit", async () => {
    await expect(runPlanner(goal, skill, "", cfg, ".", runnerReturning({ code: 1, raw: "boom" }))).rejects.toThrow(
      /planner exited 1/,
    );
  });

  it("throws on a timeout", async () => {
    await expect(runPlanner(goal, skill, "", cfg, ".", runnerReturning({ timedOut: true }))).rejects.toThrow(/timed out/i);
  });

  it("throws when the output cannot be parsed", async () => {
    await expect(runPlanner(goal, skill, "", cfg, ".", runnerReturning({ text: "I could not." }))).rejects.toThrow(
      /not parseable/i,
    );
  });

  it("throws on an empty draft", async () => {
    await expect(runPlanner(goal, skill, "", cfg, ".", runnerReturning({ text: "```json\n[]\n```" }))).rejects.toThrow(
      /no tickets/i,
    );
  });

  it("throws when the draft has blocking validation errors", async () => {
    // Missing title is a resolvePlan error → planner refuses.
    await expect(
      runPlanner(goal, skill, "", cfg, ".", runnerReturning({ text: '```json\n[{"id":"a"}]\n```' })),
    ).rejects.toThrow(/invalid tickets/i);
  });

  it.each(adapterFixtures)("resolves the %s planner model to the lead's hard tier", async (_name, fixtureCfg) => {
    let seenModel: string | undefined = "unset";
    const runner: PlannerRunner = async (_prompt, model) => {
      seenModel = model;
      return { code: 0, timedOut: false, text: '```json\n[{"title":"x"}]\n```', raw: "" };
    };
    await runPlanner(goal, skill, "", fixtureCfg, ".", runner);
    expect(seenModel).toBe(fixtureCfg.adapters[fixtureCfg.lead].models?.hard);
  });
});
