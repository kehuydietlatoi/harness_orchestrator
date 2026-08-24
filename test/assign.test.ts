import { describe, expect, it } from "vitest";
import { applyPlan, formatBrief, rollupTelemetry, selectUnassigned } from "../src/assign.js";
import type { OrchConfig } from "../src/config.js";
import type { Issue } from "../src/github.js";
import type { RunRecord } from "../src/telemetry.js";

function issue(number: number, labels: string[] = [], body = ""): Issue {
  return {
    number,
    title: `Task ${number}`,
    body,
    state: "OPEN",
    labels,
    assignees: [],
  };
}

function run(
  issueNumber: number,
  agent: string,
  outcome: string,
  tokensTotal: number | null,
  costUsd: number | null,
  durationMs: number,
): RunRecord {
  return {
    ts: `2026-08-${String(issueNumber).padStart(2, "0")}T00:00:00.000Z`,
    project: "orch",
    issue: issueNumber,
    agent,
    outcome,
    durationMs,
    tokensIn: null,
    tokensOut: null,
    tokensTotal,
    costUsd,
  };
}

describe("selectUnassigned", () => {
  it("excludes either routing label while retaining dependency-blocked issues", () => {
    const blocked = issue(1, ["status:blocked"], "Depends-on: #99");
    const closed = { ...issue(5), state: "CLOSED" };

    expect(
      selectUnassigned([
        blocked,
        issue(2, ["agent:claude"]),
        issue(3, ["effort:hard"]),
        issue(4, ["agent:codex", "effort:easy"]),
        closed,
      ]).map((candidate) => candidate.number),
    ).toEqual([1]);
  });
});

describe("rollupTelemetry", () => {
  it("computes per-agent medians, success rate, and the last three runs", () => {
    const records = [
      run(1, "claude", "submitted", 100, 0.1, 10),
      run(2, "claude", "failed", 300, null, 40),
      run(3, "claude", "auto-submitted", null, 0.3, 20),
      run(4, "claude", "success", 200, 0.2, 30),
      run(5, "codex", "failed", 50, 0.05, 5),
    ];

    expect(rollupTelemetry(records, ["claude", "codex"])).toEqual([
      {
        agent: "claude",
        runs: 4,
        successRate: 0.75,
        medianTokens: 200,
        medianCost: 0.2,
        medianDurationMs: 25,
        lastRuns: [
          { issue: 2, outcome: "failed", tokens: 300, cost: null },
          { issue: 3, outcome: "auto-submitted", tokens: null, cost: 0.3 },
          { issue: 4, outcome: "success", tokens: 200, cost: 0.2 },
        ],
      },
      {
        agent: "codex",
        runs: 1,
        successRate: 0,
        medianTokens: 50,
        medianCost: 0.05,
        medianDurationMs: 5,
        lastRuns: [{ issue: 5, outcome: "failed", tokens: 50, cost: 0.05 }],
      },
    ]);
  });

  it("returns zeroes and no history for agents without telemetry", () => {
    expect(rollupTelemetry([], ["claude"])).toEqual([
      {
        agent: "claude",
        runs: 0,
        successRate: 0,
        medianTokens: 0,
        medianCost: 0,
        medianDurationMs: 0,
        lastRuns: [],
      },
    ]);
  });
});

describe("formatBrief", () => {
  it("includes routing details for blank issues and omits pinned issues", () => {
    const brief = formatBrief(
      [
        issue(8, [], "Work here.\n\n**Files (ownership hint):** `src/a.ts`\n\nDepends-on: #7"),
        issue(9, ["agent:codex"], "Do not include"),
      ],
      rollupTelemetry([], ["claude"]),
    );

    expect(brief).toContain("#8 Task 8");
    expect(brief).toContain("Work here.");
    expect(brief).toContain("Depends-on: #7");
    expect(brief).toContain("Files hint: `src/a.ts`");
    expect(brief).toContain("claude: no history");
    expect(brief).not.toContain("#9 Task 9");
  });
});

describe("applyPlan", () => {
  it("plans blank writes and reports pins and invalid entries without aborting", () => {
    const cfg = { agents: ["claude", "codex"] } as Pick<OrchConfig, "agents">;
    const result = applyPlan(
      [
        { issue: 1, agent: "claude", effort: "hard" },
        { issue: 2, agent: "codex", effort: "easy" },
        { issue: 3, agent: "codex", effort: "hard" },
        { issue: 4, agent: "other", effort: "easy" },
        { issue: 5, agent: "codex", effort: "huge" },
        { issue: 99, agent: "codex", effort: "easy" },
      ],
      [
        issue(1),
        issue(2, ["agent:claude"]),
        issue(3, ["effort:easy"]),
        issue(4),
        issue(5),
      ],
      cfg,
    );

    expect(result.writes).toEqual([{ issue: 1, agent: "claude", effort: "hard" }]);
    expect(result.skips).toEqual([
      { issue: 2, reason: "already pinned" },
      { issue: 3, reason: "already pinned" },
      { issue: 4, reason: "invalid agent 'other' (expected one of: claude, codex)" },
      { issue: 5, reason: "invalid effort 'huge' (expected easy or hard)" },
      { issue: 99, reason: "open issue not found" },
    ]);
  });
});
