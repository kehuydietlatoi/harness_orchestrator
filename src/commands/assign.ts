import { readFileSync } from "node:fs";
import pc from "picocolors";
import { applyPlan, formatBrief, rollupTelemetry, type PlanEntry, type PlanSkip } from "../assign.js";
import { loadConfig } from "../config.js";
import { editIssue, listIssues } from "../github.js";
import { agentLabel, effortLabel } from "../labels.js";
import { assignRoundRobin } from "../plan.js";
import { readRuns } from "../telemetry.js";

export interface AssignOptions {
  apply?: string;
  dryRun?: boolean;
  roundRobin?: boolean;
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

export async function assignCommand(opts: AssignOptions): Promise<void> {
  const cwd = process.cwd();
  const cfg = loadConfig(cwd);

  if (opts.roundRobin && opts.apply) throw new Error("--round-robin cannot be combined with --apply");
  if (opts.dryRun && !opts.apply) throw new Error("--dry-run requires --apply <plan.json|->");

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
  if (!opts.apply) {
    console.log(formatBrief(issues, rollupTelemetry(readRuns(cwd), cfg.agents)));
    return;
  }

  const result = applyPlan(readPlan(opts.apply), issues, cfg);
  console.log(pc.bold(opts.dryRun ? "Assignment plan (dry run):" : "Assignment plan:"));
  for (const write of result.writes) {
    const diff = `+${agentLabel(write.agent)} +${effortLabel(write.effort)}`;
    console.log(`  #${write.issue} ${diff}`);
    if (!opts.dryRun) {
      await editIssue(write.issue, {
        cwd,
        addLabels: [agentLabel(write.agent), effortLabel(write.effort)],
      });
    }
  }
  result.skips.forEach(printSkip);
  if (result.writes.length === 0 && result.skips.length === 0) console.log(pc.dim("  (empty plan)"));
}
