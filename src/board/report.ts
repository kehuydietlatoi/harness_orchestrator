import type { OrchEvent } from "../tasks/events.js";
import type { RunRecord } from "./telemetry.js";

/**
 * The run report: what the autonomous loop achieved and what it cost, derived purely from the
 * local event log (`events.jsonl`) and run telemetry (`runs.jsonl`). It covers the tasks the loop
 * touched (at least one event in range); their runs count toward cost, but a task that was only
 * ever run by hand (`orch run`) has no loop outcome and is left out. Both logs are advisory, so the
 * report is a measurement, never lifecycle truth. Costs are only known for per-token agents
 * (Codex runs on a flat subscription), so every cost carries whether it is complete, and an
 * unknown cost is reported as unknown, never as zero.
 */

export type TaskOutcome = "merged" | "escalated" | "open";

export interface TaskReport {
  issue: number;
  outcome: TaskOutcome;
  /** Fix and conflict rounds pushed. */
  fixRounds: number;
  reviews: { approved: number; changesRequested: number };
  /** The lead granted another round at least once. */
  triaged: boolean;
  /** Harness runs recorded for the task (implement, fix, conflict, review, triage). */
  agentRuns: number;
  /** Sum of the known run costs (USD); null when no run reported one. */
  costUsd: number | null;
  /** Every run reported a cost, so `costUsd` is the whole cost. */
  costComplete: boolean;
  /** First recorded activity to merge (merged tasks only). */
  durationMs: number | null;
}

export interface RunReport {
  tasks: TaskReport[];
  totals: {
    tasks: number;
    merged: number;
    escalated: number;
    open: number;
    /** Escalated / (merged + escalated); null before anything finished. */
    escalationRate: number | null;
    /** Mean fix rounds of merged tasks: rounds to approval. */
    meanFixRounds: number | null;
    costUsd: number | null;
    costComplete: boolean;
    /** Known cost divided by merged tasks; a lower bound when the cost is incomplete. */
    costPerMerged: number | null;
  };
}

export interface ReportScope {
  /** Only activity at or after this time. */
  since?: Date;
  /** Only these issues. */
  issues?: ReadonlySet<number>;
}

function inScope(issue: number, ts: string, scope: ReportScope): boolean {
  if (scope.issues && !scope.issues.has(issue)) return false;
  if (scope.since) {
    const at = Date.parse(ts);
    if (!Number.isFinite(at) || at < scope.since.getTime()) return false;
  }
  return true;
}

function mean(values: readonly number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

/** Build the report for the activity in `scope`. Pure. */
export function buildRunReport(events: readonly OrchEvent[], runs: readonly RunRecord[], scope: ReportScope = {}): RunReport {
  const byIssue = new Map<number, TaskReport & { firstAt: number | null; mergedAt: number | null }>();
  const task = (issue: number) => {
    let t = byIssue.get(issue);
    if (!t) {
      t = {
        issue, outcome: "open", fixRounds: 0, reviews: { approved: 0, changesRequested: 0 }, triaged: false,
        agentRuns: 0, costUsd: null, costComplete: true, durationMs: null, firstAt: null, mergedAt: null,
      };
      byIssue.set(issue, t);
    }
    return t;
  };
  const seen = (t: { firstAt: number | null }, ts: string): void => {
    const at = Date.parse(ts);
    if (Number.isFinite(at) && (t.firstAt === null || at < t.firstAt)) t.firstAt = at;
  };

  for (const e of events) {
    if (!inScope(e.issue, e.ts, scope)) continue;
    const t = task(e.issue);
    seen(t, e.ts);
    if (e.type !== "step.finished") continue;
    switch (e.signal) {
      case "fix.pushed": case "conflict.resolved": t.fixRounds += 1; break;
      case "review.approved": t.reviews.approved += 1; break;
      case "review.changes_requested": t.reviews.changesRequested += 1; break;
      case "triage.retry": t.triaged = true; break;
      // The last terminal signal wins: a human can hand an escalated task back and it may merge later.
      case "task.escalated": t.outcome = "escalated"; break;
      case "task.merged": {
        t.outcome = "merged";
        const at = Date.parse(e.ts);
        t.mergedAt = Number.isFinite(at) ? at : null;
        break;
      }
    }
  }

  for (const r of runs) {
    // Only tasks the loop touched: a run with no loop event (a plain `orch run`) has no outcome to report.
    if (!inScope(r.issue, r.ts, scope) || !byIssue.has(r.issue)) continue;
    const t = task(r.issue);
    seen(t, r.ts);
    t.agentRuns += 1;
    if (r.costUsd === null || !Number.isFinite(r.costUsd)) t.costComplete = false;
    else t.costUsd = (t.costUsd ?? 0) + r.costUsd;
  }

  const tasks: TaskReport[] = [...byIssue.values()]
    .sort((a, b) => a.issue - b.issue)
    .map(({ firstAt, mergedAt, ...t }) => ({
      ...t,
      durationMs: t.outcome === "merged" && firstAt !== null && mergedAt !== null ? Math.max(0, mergedAt - firstAt) : null,
    }));

  const merged = tasks.filter((t) => t.outcome === "merged");
  const escalated = tasks.filter((t) => t.outcome === "escalated").length;
  const known = tasks.filter((t) => t.costUsd !== null);
  const costUsd = known.length ? known.reduce((sum, t) => sum + (t.costUsd ?? 0), 0) : null;
  return {
    tasks,
    totals: {
      tasks: tasks.length,
      merged: merged.length,
      escalated,
      open: tasks.length - merged.length - escalated,
      escalationRate: merged.length + escalated ? escalated / (merged.length + escalated) : null,
      meanFixRounds: mean(merged.map((t) => t.fixRounds)),
      costUsd,
      costComplete: tasks.every((t) => t.costComplete),
      costPerMerged: costUsd !== null && merged.length ? costUsd / merged.length : null,
    },
  };
}

function money(value: number | null, complete: boolean): string {
  if (value === null) return "unknown";
  return `${complete ? "" : ">= "}$${value.toFixed(2)}`;
}

function minutes(ms: number | null): string {
  return ms === null ? "-" : `${Math.round(ms / 60_000)} min`;
}

/** Render the report as terminal text. Pure. */
export function formatRunReport(report: RunReport): string {
  const { totals } = report;
  if (totals.tasks === 0) return "No autopilot activity in this range.";
  const lines = [
    `Tasks: ${totals.tasks}  merged ${totals.merged}  escalated ${totals.escalated}  open ${totals.open}`,
    `Escalation rate: ${totals.escalationRate === null ? "-" : `${Math.round(totals.escalationRate * 100)}%`}` +
      `   Rounds to approval (mean, merged): ${totals.meanFixRounds === null ? "-" : totals.meanFixRounds.toFixed(1)}`,
    `Cost: ${money(totals.costUsd, totals.costComplete)}   per merged task: ${money(totals.costPerMerged, totals.costComplete)}` +
      (totals.costComplete ? "" : "   (some runs report no cost, e.g. flat-rate Codex)"),
    "",
    "  issue  outcome    rounds  reviews(+/-)  triaged  runs  cost       time",
  ];
  for (const t of report.tasks) {
    lines.push(
      `  #${String(t.issue).padEnd(5)} ${t.outcome.padEnd(10)} ${String(t.fixRounds).padEnd(7)} ` +
        `${`${t.reviews.approved}/${t.reviews.changesRequested}`.padEnd(13)} ${(t.triaged ? "yes" : "-").padEnd(8)} ` +
        `${String(t.agentRuns).padEnd(5)} ${money(t.costUsd, t.costComplete).padEnd(10)} ${minutes(t.durationMs)}`,
    );
  }
  return lines.join("\n");
}

/** Parse `--since`: an ISO date/time, or a relative `<n>h` / `<n>d` / `<n>m`. Throws on anything else. */
export function parseSince(value: string, now: Date = new Date()): Date {
  const relative = value.trim().match(/^(\d+)\s*([mhd])$/i);
  if (relative) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2].toLowerCase() as "m" | "h" | "d"];
    return new Date(now.getTime() - Number(relative[1]) * unit);
  }
  const at = Date.parse(value);
  if (!Number.isFinite(at)) throw new Error(`--since must be an ISO date/time or a relative 30m / 12h / 7d (got '${value}')`);
  return new Date(at);
}
