import { readFileSync } from "node:fs";
import pc from "picocolors";
import {
  applyPlan,
  formatBrief,
  rollupTelemetry,
  selectUnassigned,
  type PlannedAssignments,
  type PlanEntry,
  type PlanSkip,
} from "../assign.js";
import { loadConfig } from "../config.js";
import { editIssue, listIssues, type Issue } from "../github.js";
import { agentLabel, effortLabel, ASSIGNED_BY_BRAIN } from "../labels.js";
import { runJudge } from "../judge.js";
import { evaluatePlan, type EvalReport } from "../judge-eval.js";
import { assignRoundRobin } from "../plan.js";
import { readRuns } from "../telemetry.js";

export interface AssignOptions {
  apply?: string;
  dryRun?: boolean;
  roundRobin?: boolean;
  judge?: boolean;
  auto?: boolean;
}

function readPlan(path: string): PlanEntry[] {
  const raw = readFileSync(path === "-" ? 0 : path, "utf8").replace(/^\uFEFF/, "");
  const value = JSON.parse(raw) as unknown;
  if (!Array.isArray(value)) throw new Error("assignment plan must be a JSON array");

  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`assignment plan entry ${index + 1} must be an object`);
    }
    const candidate = entry as Record<string, unknown>;
    if (!Number.isInteger(candidate.issue)) {
      throw new Error(`assignment plan entry ${index + 1} needs an integer issue number`);
    }
    return {
      issue: candidate.issue as number,
      agent: typeof candidate.agent === "string" ? candidate.agent : String(candidate.agent),
      effort: typeof candidate.effort === "string" ? candidate.effort : String(candidate.effort),
    };
  });
}

function printSkip(skip: PlanSkip): void {
  console.log(`  #${skip.issue} SKIP (${skip.reason})`);
}

/**
 * Apply a partitioned plan to labels. `brain` adds the `assigned-by:brain`
 * provenance label so a judge-authored routing is distinguishable from a human
 * one; `dryRun` prints the diff without writing. Shared by --apply and --auto.
 */
async function writeAssignments(
  result: PlannedAssignments,
  cwd: string,
  opts: { brain: boolean; dryRun: boolean },
): Promise<void> {
  console.log(pc.bold(opts.dryRun ? "Assignment plan (dry run):" : "Assignment plan:"));
  for (const write of result.writes) {
    const labels = [agentLabel(write.agent), effortLabel(write.effort)];
    if (opts.brain) labels.push(ASSIGNED_BY_BRAIN);
    console.log(`  #${write.issue} ${labels.map((l) => `+${l}`).join(" ")}`);
    if (!opts.dryRun) await editIssue(write.issue, { cwd, addLabels: labels });
  }
  result.skips.forEach(printSkip);
  if (result.writes.length === 0 && result.skips.length === 0) console.log(pc.dim("  (empty plan)"));
}

function briefFor(issues: Issue[], cwd: string, cfg: { agents: string[] }): string {
  return formatBrief(issues, rollupTelemetry(readRuns(cwd), cfg.agents));
}

/**
 * Warn (on stderr, so piped `--judge` JSON stays clean) about the two contract
 * failures `applyPlan` is blind to: an unassigned issue the judge forgot, and a
 * blank rationale. Invalid/duplicate/extra entries are already surfaced as skips.
 */
function warnJudgeGaps(report: EvalReport): void {
  const gaps = report.violations.filter(
    (v) => v.kind === "coverage-missing" || v.kind === "missing-rationale",
  );
  if (gaps.length === 0) return;
  console.error(pc.yellow(`judge plan incomplete: ${gaps.length} issue(s) need attention`));
  for (const gap of gaps) console.error(pc.dim(`  #${gap.issue} ${gap.kind} (${gap.detail})`));
}

export async function assignCommand(opts: AssignOptions): Promise<void> {
  const cwd = process.cwd();
  const cfg = loadConfig(cwd);

  const judging = opts.judge || opts.auto;
  if (judging && (opts.apply || opts.roundRobin)) {
    throw new Error("--judge/--auto cannot be combined with --apply or --round-robin");
  }
  if (opts.roundRobin && opts.apply) throw new Error("--round-robin cannot be combined with --apply");
  if (opts.dryRun && !opts.apply && !opts.auto) {
    throw new Error("--dry-run requires --apply <plan.json|-> or --auto");
  }

  if (opts.roundRobin) {
    const assignments = await assignRoundRobin(cfg, cwd);
    if (!assignments.length) {
      console.log(pc.yellow("Nothing eligible to assign."));
      return;
    }
    console.log(pc.bold("Assigned:"));
    assignments.forEach((assignment) => console.log(`  #${assignment.issue} -> ${assignment.agent}`));
    return;
  }

  const issues = await listIssues({ cwd, state: "open" });

  // The judge turns the brief into a plan. --judge emits it; --auto applies it.
  if (judging) {
    if (selectUnassigned(issues).length === 0) {
      console.log(pc.yellow("Nothing to route — every open issue already has agent:/effort: labels."));
      return;
    }
    const plan = await runJudge(briefFor(issues, cwd, cfg), cfg, cwd); // fail-closed: throws => no writes
    warnJudgeGaps(evaluatePlan(plan, issues, cfg)); // completeness check the writer can't do
    if (!opts.auto) {
      console.log(JSON.stringify(plan, null, 2));
      return;
    }
    await writeAssignments(applyPlan(plan, issues, cfg), cwd, { brain: true, dryRun: Boolean(opts.dryRun) });
    return;
  }

  if (!opts.apply) {
    console.log(briefFor(issues, cwd, cfg));
    return;
  }

  await writeAssignments(applyPlan(readPlan(opts.apply), issues, cfg), cwd, {
    brain: false,
    dryRun: Boolean(opts.dryRun),
  });
}
