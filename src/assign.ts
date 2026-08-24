import { parseDeps } from "./board.js";
import type { OrchConfig } from "./config.js";
import type { Issue } from "./github.js";
import type { RunRecord } from "./telemetry.js";

export type Effort = "easy" | "hard";

export interface PlanEntry {
  issue: number;
  agent: string;
  effort: string;
}

export interface Plan extends PlanEntry {
  effort: Effort;
}

export interface LastRun {
  issue: number;
  outcome: string;
  tokens: number | null;
  cost: number | null;
}

export interface AgentRollup {
  agent: string;
  runs: number;
  successRate: number;
  medianTokens: number;
  medianCost: number;
  medianDurationMs: number;
  lastRuns: LastRun[];
}

export interface PlanSkip {
  issue: number;
  reason: string;
}

export interface PlannedAssignments {
  writes: Plan[];
  skips: PlanSkip[];
}

function hasRoutingLabel(issue: Issue): boolean {
  return issue.labels.some((label) => label.startsWith("agent:") || label.startsWith("effort:"));
}

/** Select all open issues with both routing fields blank, regardless of dependency state. */
export function selectUnassigned(issues: readonly Issue[]): Issue[] {
  return issues.filter((issue) => issue.state.toUpperCase() === "OPEN" && !hasRoutingLabel(issue));
}

function median(values: Array<number | null>): number {
  const sorted = values
    .filter((value): value is number => value !== null && Number.isFinite(value))
    .sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function isSuccessful(outcome: string): boolean {
  return ["success", "succeeded", "submitted", "auto-submitted"].includes(outcome.toLowerCase());
}

/** Aggregate historical run performance for every configured agent. */
export function rollupTelemetry(runs: readonly RunRecord[], agents: readonly string[]): AgentRollup[] {
  return agents.map((agent) => {
    const history = runs.filter((run) => run.agent === agent);
    const successes = history.filter((run) => isSuccessful(run.outcome)).length;
    return {
      agent,
      runs: history.length,
      successRate: history.length === 0 ? 0 : successes / history.length,
      medianTokens: median(history.map((run) => run.tokensTotal)),
      medianCost: median(history.map((run) => run.costUsd)),
      medianDurationMs: median(history.map((run) => run.durationMs)),
      lastRuns: history.slice(-3).map((run) => ({
        issue: run.issue,
        outcome: run.outcome,
        tokens: run.tokensTotal,
        cost: run.costUsd,
      })),
    };
  });
}

function filesHint(body: string): string | null {
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/files(?:\s*\(ownership hint\))?\s*:\*{0,2}\s*(.+?)\s*$/i);
    if (match) return match[1];
  }
  return null;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

/** Render the deterministic prompt/input a lead uses to produce an assignment plan. */
export function formatBrief(issues: readonly Issue[], rollup: readonly AgentRollup[]): string {
  const unassigned = selectUnassigned(issues).sort((a, b) => a.number - b.number);
  const lines = ["Routing brief", "", `Unassigned open issues: ${unassigned.length}`];

  if (unassigned.length === 0) {
    lines.push("(none)");
  } else {
    for (const issue of unassigned) {
      const deps = parseDeps(issue.body);
      const files = filesHint(issue.body);
      lines.push(
        "",
        `#${issue.number} ${issue.title}`,
        "Body:",
        issue.body.trim() || "_(no description)_",
        `Depends-on: ${deps.length > 0 ? deps.map((dep) => `#${dep}`).join(", ") : "none"}`,
        `Files hint: ${files ?? "none"}`,
      );
    }
  }

  lines.push("", "Telemetry by agent:");
  for (const agent of rollup) {
    if (agent.runs === 0) {
      lines.push(`- ${agent.agent}: no history (runs=0, successRate=0, medianTokens=0, medianCost=0, medianDurationMs=0)`);
      continue;
    }
    lines.push(
      `- ${agent.agent}: runs=${agent.runs}, successRate=${(agent.successRate * 100).toFixed(1)}%, ` +
        `medianTokens=${formatNumber(agent.medianTokens)}, medianCost=${formatNumber(agent.medianCost)}, ` +
        `medianDurationMs=${formatNumber(agent.medianDurationMs)}`,
    );
    for (const run of agent.lastRuns) {
      lines.push(
        `  - #${run.issue} outcome=${run.outcome} tokens=${run.tokens ?? "unknown"} cost=${run.cost ?? "unknown"}`,
      );
    }
  }
  if (rollup.length === 0) lines.push("(no configured agents)");

  return lines.join("\n");
}

/** Validate a plan and partition it into writes and non-fatal skips without doing IO. */
export function applyPlan(
  plan: readonly PlanEntry[],
  issues: readonly Issue[],
  cfg: Pick<OrchConfig, "agents">,
): PlannedAssignments {
  const issueByNumber = new Map(
    issues.filter((issue) => issue.state.toUpperCase() === "OPEN").map((issue) => [issue.number, issue]),
  );
  const planned = new Set<number>();
  const writes: Plan[] = [];
  const skips: PlanSkip[] = [];

  for (const entry of plan) {
    const issue = issueByNumber.get(entry.issue);
    if (!issue) {
      skips.push({ issue: entry.issue, reason: "open issue not found" });
      continue;
    }
    if (hasRoutingLabel(issue)) {
      skips.push({ issue: entry.issue, reason: "already pinned" });
      continue;
    }
    if (!cfg.agents.includes(entry.agent)) {
      skips.push({
        issue: entry.issue,
        reason: `invalid agent '${entry.agent}' (expected one of: ${cfg.agents.join(", ")})`,
      });
      continue;
    }
    if (entry.effort !== "easy" && entry.effort !== "hard") {
      skips.push({ issue: entry.issue, reason: `invalid effort '${entry.effort}' (expected easy or hard)` });
      continue;
    }
    if (planned.has(entry.issue)) {
      skips.push({ issue: entry.issue, reason: "duplicate plan entry" });
      continue;
    }

    planned.add(entry.issue);
    writes.push({ ...entry, effort: entry.effort });
  }

  return { writes, skips };
}
