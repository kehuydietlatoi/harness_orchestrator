import { describe, expect, it } from "vitest";
import { evaluatePlan, summarizeReport } from "../src/routing/judge-eval.js";
import { formatBrief, rollupTelemetry, type PlanEntry } from "../src/routing/assign.js";
import { runJudge } from "../src/routing/judge.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { Issue } from "../src/github/github.js";

const cfg = DEFAULT_CONFIG;

function mkIssue(number: number, title: string, opts: Partial<Issue> = {}): Issue {
  return {
    number,
    title,
    body: opts.body ?? `Do ${title}.\nDepends-on: none\nFiles: src/${title}.ts`,
    state: opts.state ?? "OPEN",
    labels: opts.labels ?? [],
    assignees: opts.assignees ?? [],
  };
}

// A realistic board: three unassigned todos, one already-routed task, one closed.
const ISSUES: Issue[] = [
  mkIssue(107, "dashboard-routing-ui"),
  mkIssue(108, "cross-review-backlog-view"),
  mkIssue(109, "telemetry-judge-scoring"),
  mkIssue(103, "already-routed", { labels: ["agent:claude", "effort:hard"] }),
  mkIssue(90, "shipped", { state: "CLOSED" }),
];

const EXPECTED = [107, 108, 109];

function entry(issue: number, over: Partial<PlanEntry> = {}): PlanEntry {
  return { issue, agent: "codex", effort: "easy", rationale: "grounded in telemetry", ...over };
}

describe("evaluatePlan — validity invariants", () => {
  it("passes a complete, well-formed plan and reports the covered set", () => {
    const plan: PlanEntry[] = [
      entry(107, { agent: "claude", effort: "hard" }),
      entry(108, { agent: "codex", effort: "easy" }),
      entry(109, { agent: "codex", effort: "hard" }),
    ];
    const report = evaluatePlan(plan, ISSUES, cfg);

    expect(report.ok).toBe(true);
    expect(report.violations).toEqual([]);
    expect(report.expected).toEqual(EXPECTED);
    expect(report.routed).toEqual(EXPECTED);
    expect(summarizeReport(report)).toBe("3/3 routed, valid");
  });

  it("flags an unassigned issue the plan forgot (the gap applyPlan cannot see)", () => {
    const plan = [entry(107, { agent: "claude", effort: "hard" }), entry(108)];
    const report = evaluatePlan(plan, ISSUES, cfg);

    expect(report.ok).toBe(false);
    expect(report.violations).toEqual([{ kind: "coverage-missing", issue: 109, detail: "no plan entry" }]);
    expect(report.routed).toEqual([107, 108]);
    expect(summarizeReport(report)).toBe("2/3 routed, 1 violation(s)");
  });

  it("flags entries for issues that are closed, unknown, or already pinned", () => {
    const plan = [
      entry(107, { agent: "claude", effort: "hard" }),
      entry(108),
      entry(109, { effort: "hard" }),
      entry(103), // already has agent:/effort:
      entry(90), // closed
      entry(555), // unknown
    ];
    const kinds = evaluatePlan(plan, ISSUES, cfg).violations.filter((v) => v.kind === "coverage-extra");
    expect(kinds.map((v) => v.issue)).toEqual([90, 103, 555]);
  });

  it("flags a bad agent, a bad effort tier, a blank rationale, and a duplicate", () => {
    const plan = [
      entry(107, { agent: "gpt-5", effort: "hard" }), // invalid-agent
      entry(108, { effort: "medium" }), // invalid-effort
      entry(109, { rationale: "   " }), // missing-rationale
      entry(107, { agent: "claude", effort: "hard" }), // duplicate of 107
    ];
    const byKind = new Map<string, number[]>();
    for (const v of evaluatePlan(plan, ISSUES, cfg).violations) {
      byKind.set(v.kind, [...(byKind.get(v.kind) ?? []), v.issue]);
    }

    expect(byKind.get("invalid-agent")).toEqual([107]);
    expect(byKind.get("invalid-effort")).toEqual([108]);
    expect(byKind.get("missing-rationale")).toEqual([109]);
    expect(byKind.get("duplicate")).toEqual([107]);
  });

  it("is stably ordered by issue then kind", () => {
    const plan = [entry(108, { agent: "nope", effort: "medium" })];
    const kinds = evaluatePlan(plan, ISSUES, cfg).violations.map((v) => `${v.issue}:${v.kind}`);
    // Sorted by issue first, then kind — so 108's two field faults sit between the
    // coverage-missing entries for 107 and 109, not grouped by kind.
    expect(kinds).toEqual(["107:coverage-missing", "108:invalid-agent", "108:invalid-effort", "109:coverage-missing"]);
  });
});

// Opt-in live check: runs the REAL judge (spawns `claude`) against golden issues and
// asserts its output clears the validity gate. Skipped unless ORCH_JUDGE_LIVE is set,
// so CI stays hermetic. Enable with: ORCH_JUDGE_LIVE=1 npm test
describe.skipIf(!process.env.ORCH_JUDGE_LIVE)("evaluatePlan — live judge", () => {
  it(
    "the real judge produces a contract-valid plan for the golden board",
    async () => {
      const brief = formatBrief(ISSUES, rollupTelemetry([], cfg.agents));
      const plan = await runJudge(brief, cfg, process.cwd());
      const report = evaluatePlan(plan, ISSUES, cfg);
      // Surface the reasoning on failure — the model's plan is the artifact under test.
      expect(report.violations, JSON.stringify({ plan, report }, null, 2)).toEqual([]);
    },
    120_000,
  );
});
