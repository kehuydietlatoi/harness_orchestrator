import { readFileSync } from "node:fs";
import pc from "picocolors";
import { loadConfig } from "../config.js";
import { createFromPlan, parseTickets, resolvePlan, type ResolvedPlan } from "../tasks/plan.js";
import { loadPlanSkill, runPlanner } from "../tasks/planner.js";
import { exec } from "../util/exec.js";

export interface PlanOptions {
  draft?: string;
  dryRun?: boolean;
  example?: boolean;
}

/** Shallow repo context (tracked files) so the planner produces realistic file hints. */
async function repoContext(cwd: string): Promise<string> {
  const r = await exec("git", ["ls-files"], { cwd });
  if (r.code !== 0) return "";
  const files = r.stdout.split(/\r?\n/).filter(Boolean).slice(0, 200);
  return files.length ? `Repository files:\n${files.join("\n")}` : "";
}

/** Render a resolved plan for humans: the issues that would be created, plus warnings/errors. */
function printPreview(plan: ResolvedPlan): void {
  console.log(pc.bold(`Would create ${plan.tickets.length} issue(s):`));
  for (const t of plan.tickets) {
    const meta = [
      t.id && `id:${t.id}`,
      t.knownDeps.length && `deps:${t.knownDeps.join(",")}`,
      t.files.length && `files:${t.files.join(", ")}`,
    ]
      .filter(Boolean)
      .join("  ");
    console.log(`  ${t.index}. ${t.title}${meta ? pc.dim(`  (${meta})`) : ""}`);
  }
  plan.warnings.forEach((w) => console.log(pc.yellow(`  warning: ${w}`)));
  plan.errors.forEach((e) => console.log(pc.red(`  error: ${e}`)));
  if (!plan.errors.length) console.log(pc.dim("  (dry run — no issues created)"));
}

export async function planCommand(file: string | undefined, opts: PlanOptions): Promise<void> {
  const cwd = process.cwd();

  // --example: print the shipped template. No repo/config needed.
  if (opts.example) {
    process.stdout.write(readFileSync(new URL("../../tickets.example.json", import.meta.url), "utf8"));
    return;
  }

  // --draft: LLM decomposes a goal into a tickets.json (fail-closed). Needs config
  // (adapter/model). JSON to stdout; advisory warnings to stderr so
  // `orch plan --draft "…" > tickets.json` stays clean.
  if (opts.draft) {
    const cfg = loadConfig(cwd);
    const tickets = await runPlanner(opts.draft, loadPlanSkill(), await repoContext(cwd), cfg, cwd);
    resolvePlan(tickets).warnings.forEach((w) => console.error(pc.dim(`warning: ${w}`)));
    process.stdout.write(`${JSON.stringify(tickets, null, 2)}\n`);
    return;
  }

  if (!file) {
    throw new Error('provide a tickets file, or use --draft "<goal>" or --example');
  }

  const tickets = parseTickets(readFileSync(file, "utf8"));
  const plan = resolvePlan(tickets);

  // --dry-run: pure validate + preview, write nothing (no repo/config needed).
  if (opts.dryRun) {
    printPreview(plan);
    return;
  }

  // Default: create the issues. Refuse (with the preview) if there are blocking errors.
  if (plan.errors.length) {
    printPreview(plan);
    throw new Error(`refusing to create: ${plan.errors.length} error(s) in ${file}`);
  }
  loadConfig(cwd); // ensure an initialised orch repo before writing
  const created = await createFromPlan(tickets, cwd);
  console.log(pc.green(`Created ${created.length} issue(s):`));
  created.forEach((c) => console.log(`  #${c.number} ${c.title}${c.id ? pc.dim(` (${c.id})`) : ""}`));
}
