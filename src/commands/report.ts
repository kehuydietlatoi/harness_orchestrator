import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import pc from "picocolors";
import { runHeadlessAgent } from "../adapters/headless.js";
import { makeAdapter } from "../adapters/index.js";
import { buildRunReport, formatRunReport, parseSince, type RunReport } from "../board/report.js";
import { readRuns } from "../board/telemetry.js";
import { loadConfig, resolveLeadModel, type OrchConfig } from "../config.js";
import { listIssues } from "../github/github.js";
import { readEvents } from "../tasks/events.js";
import { formatSummaryPrompt, parseSummary, type SummaryTask } from "../tasks/report-summary.js";
import { parseIssueList } from "./autopilot.js";

/** File the lead's follow-up draft is written to; review it with `orch plan --dry-run`. */
export const FOLLOWUP_FILE = "tickets.followup.json";

/** The run report for a range, from local telemetry. */
export function runReport(cwd: string, scope: { since?: Date; issues?: ReadonlySet<number> } = {}): RunReport {
  return buildRunReport(readEvents(cwd), readRuns(cwd), scope);
}

/**
 * Have the lead summarise a report and draft follow-up tickets. Writes the draft to
 * `tickets.followup.json` (never creates issues). Best-effort: a failed summary prints why.
 */
export async function summarizeReport(report: RunReport, cfg: OrchConfig, cwd: string): Promise<void> {
  if (report.tasks.length === 0) return;
  const numbers = new Set(report.tasks.map((t) => t.issue));
  const titles = new Map<number, string>();
  try {
    for (const issue of await listIssues({ cwd, state: "all" })) if (numbers.has(issue.number)) titles.set(issue.number, issue.title);
  } catch {
    // titles are a nicety; the summary still has the numbers
  }
  const escalations = new Map<number, string>();
  for (const e of readEvents(cwd)) {
    if (numbers.has(e.issue) && e.signal === "task.escalated" && e.detail) escalations.set(e.issue, e.detail);
  }
  const tasks: SummaryTask[] = report.tasks.map((t) => ({
    issue: t.issue, title: titles.get(t.issue) ?? "(title unavailable)", outcome: t.outcome,
    ...(t.outcome === "escalated" && escalations.has(t.issue) ? { escalation: escalations.get(t.issue) } : {}),
  }));

  console.log(pc.dim(`\nAsking the lead (${cfg.lead}) to summarise the run…`));
  const run = await runHeadlessAgent(makeAdapter(cfg.lead, cfg), formatSummaryPrompt(report, tasks), resolveLeadModel(cfg), cwd,
    "report-summary", cfg.reviewTimeoutMs, { readOnly: true });
  if (run.code !== 0 || run.timedOut) {
    console.log(pc.yellow(`The lead could not summarise the run (${run.timedOut ? "timed out" : `exit ${run.code}`}).`));
    return;
  }
  const summary = parseSummary(run.text || run.raw);
  console.log(`\n${summary.narrative}`);
  if (summary.tickets === null) {
    console.log(pc.yellow(`No follow-up draft written: ${summary.problem}.`));
  } else if (summary.tickets.length === 0) {
    console.log(pc.dim("No follow-up work proposed."));
  } else {
    const path = resolve(cwd, FOLLOWUP_FILE);
    writeFileSync(path, `${JSON.stringify(summary.tickets, null, 2)}\n`, "utf8");
    console.log(pc.green(`\nWrote ${summary.tickets.length} follow-up ticket(s) to ${path}.`));
    console.log(pc.dim(`Review with \`orch plan --dry-run ${FOLLOWUP_FILE}\`, then \`orch plan ${FOLLOWUP_FILE} --yes\` to run them.`));
  }
}

export async function reportCommand(opts: { since?: string; issues?: string; json?: boolean; summarize?: boolean }): Promise<void> {
  const cwd = process.cwd();
  const scope = {
    ...(opts.since ? { since: parseSince(opts.since) } : {}),
    ...(opts.issues ? { issues: parseIssueList(opts.issues) } : {}),
  };
  const report = runReport(cwd, scope);
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(formatRunReport(report));
  if (opts.summarize) await summarizeReport(report, loadConfig(cwd), cwd);
}
