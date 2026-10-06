import { describe, expect, it } from "vitest";
import { buildRunReport, formatRunReport, parseSince } from "../src/board/report.js";
import type { RunRecord } from "../src/board/telemetry.js";
import type { OrchEvent } from "../src/tasks/events.js";
import { formatSummaryPrompt, parseSummary } from "../src/tasks/report-summary.js";

const t0 = Date.parse("2026-10-07T10:00:00Z");
const at = (minutes: number): string => new Date(t0 + minutes * 60_000).toISOString();
const finished = (issue: number, minute: number, step: string, signal: string, detail?: string): OrchEvent =>
  ({ ts: at(minute), issue, type: "step.finished", step, signal, ...(detail ? { detail } : {}) });
const run = (issue: number, minute: number, agent: string, costUsd: number | null, phase: RunRecord["phase"] = "implement"): RunRecord => ({
  ts: at(minute), project: "p", issue, agent, model: null, outcome: "x", durationMs: 1,
  tokensIn: null, tokensOut: null, tokensTotal: null, costUsd, phase,
});

const events: OrchEvent[] = [
  { ts: at(0), issue: 1, type: "step.started", step: "implement" },
  finished(1, 10, "implement", "task.submitted"),
  finished(1, 12, "review", "review.changes_requested"),
  finished(1, 20, "fix", "fix.pushed"),
  finished(1, 22, "review", "review.approved"),
  finished(1, 30, "merge", "task.merged"),
  finished(2, 5, "review", "review.changes_requested"),
  finished(2, 8, "triage", "triage.retry"),
  finished(2, 9, "escalate", "task.escalated", "stuck"),
  finished(3, 15, "review", "review.approved"),
  finished(4, 1, "escalate", "task.escalated"),
  finished(4, 40, "merge", "task.merged"), // handed back by a human, then merged
];
const runs: RunRecord[] = [
  run(1, 10, "claude", 1.5), run(1, 12, "codex", null, "review"), run(1, 20, "claude", 0.5, "fix"),
  run(2, 8, "claude", 0.25, "triage"),
  run(3, 15, "claude", 2),
];

describe("buildRunReport", () => {
  it("derives outcomes, rounds, reviews, runs, cost, and time per task", () => {
    const report = buildRunReport(events, runs);
    expect(report.tasks).toEqual([
      { issue: 1, outcome: "merged", fixRounds: 1, reviews: { approved: 1, changesRequested: 1 }, triaged: false, agentRuns: 3, costUsd: 2, costComplete: false, durationMs: 30 * 60_000 },
      { issue: 2, outcome: "escalated", fixRounds: 0, reviews: { approved: 0, changesRequested: 1 }, triaged: true, agentRuns: 1, costUsd: 0.25, costComplete: true, durationMs: null },
      { issue: 3, outcome: "open", fixRounds: 0, reviews: { approved: 1, changesRequested: 0 }, triaged: false, agentRuns: 1, costUsd: 2, costComplete: true, durationMs: null },
      { issue: 4, outcome: "merged", fixRounds: 0, reviews: { approved: 0, changesRequested: 0 }, triaged: false, agentRuns: 0, costUsd: null, costComplete: true, durationMs: 39 * 60_000 },
    ]);
  });

  it("totals escalation rate, rounds to approval, and a cost that never pretends unknown is zero", () => {
    const { totals } = buildRunReport(events, runs);
    expect(totals).toEqual({
      tasks: 4, merged: 2, escalated: 1, open: 1,
      escalationRate: 1 / 3,
      meanFixRounds: 0.5,
      costUsd: 4.25,
      costComplete: false, // a Codex review reported no cost
      costPerMerged: 4.25 / 2,
    });
    expect(buildRunReport([], []).totals).toMatchObject({ tasks: 0, escalationRate: null, meanFixRounds: null, costUsd: null, costPerMerged: null });
  });

  it("covers only tasks the loop touched: a hand-run task has no outcome to report", () => {
    const report = buildRunReport(events, [...runs, run(77, 3, "codex", 9)]);
    expect(report.tasks.map((t) => t.issue)).toEqual([1, 2, 3, 4]);
    expect(report.totals.costUsd).toBe(4.25);
  });

  it("scopes to issues and to activity since a time", () => {
    expect(buildRunReport(events, runs, { issues: new Set([2]) }).tasks.map((t) => t.issue)).toEqual([2]);
    const late = buildRunReport(events, runs, { since: new Date(t0 + 14 * 60_000) });
    expect(late.tasks.map((t) => t.issue)).toEqual([1, 3, 4]);
    expect(late.tasks[0]).toMatchObject({ fixRounds: 1, agentRuns: 1, costUsd: 0.5 });
  });

  it("renders a readable table, marking an incomplete cost as a lower bound", () => {
    const text = formatRunReport(buildRunReport(events, runs));
    expect(text).toContain("merged 2  escalated 1  open 1");
    expect(text).toContain("Escalation rate: 33%");
    expect(text).toContain("Cost: >= $4.25");
    expect(text).toMatch(/#1\s+merged\s+1\s+1\/1/);
    expect(formatRunReport(buildRunReport([], []))).toBe("No autopilot activity in this range.");
  });
});

describe("parseSince", () => {
  const now = new Date("2026-10-07T12:00:00Z");
  it("reads relative minutes, hours, and days, and ISO times", () => {
    expect(parseSince("30m", now).toISOString()).toBe("2026-10-07T11:30:00.000Z");
    expect(parseSince("12h", now).toISOString()).toBe("2026-10-07T00:00:00.000Z");
    expect(parseSince("7d", now).toISOString()).toBe("2026-09-30T12:00:00.000Z");
    expect(parseSince("2026-10-01T00:00:00Z", now).toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(() => parseSince("yesterday", now)).toThrow(/--since/);
  });
});

describe("lead summary", () => {
  it("gives the lead the report and each task's outcome and escalation reason", () => {
    const prompt = formatSummaryPrompt(buildRunReport(events, runs), [{ issue: 2, title: "Add SSO", outcome: "escalated", escalation: "spec conflict" }]);
    expect(prompt).toContain("#2 Add SSO: escalated (escalated: spec conflict)");
    expect(prompt).toContain("Escalation rate");
    expect(prompt).toContain("Use [] when there is none");
  });

  it("splits the narrative from a validated follow-up draft and fails closed on a bad one", () => {
    const good = parseSummary('Two landed.\n\n```json\n[{"id":"f","title":"Follow up on SSO"}]\n```');
    expect(good).toEqual({ narrative: "Two landed.", tickets: [expect.objectContaining({ id: "f", title: "Follow up on SSO" })] });
    expect(parseSummary("All good.\n```json\n[]\n```")).toEqual({ narrative: "All good.", tickets: [] });
    expect(parseSummary("No block.")).toMatchObject({ narrative: "No block.", tickets: null });
    expect(parseSummary('x\n```json\n[{"id":"a","title":""}]\n```')).toMatchObject({ tickets: null, problem: expect.stringMatching(/needs a title/) });
    expect(parseSummary("x\n```json\n{not json}\n```").tickets).toBeNull();
  });
});
