import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import pc from "picocolors";
import { loadConfig } from "../config.js";
import { createFromPlan, parseTickets, resolvePlan, type ResolvedPlan } from "../tasks/plan.js";
import {
  ensurePlanSkill,
  formatInteractiveSeed,
  interactivePlanArgs,
  loadPlanSkill,
  runPlanner,
} from "../tasks/planner.js";
import { exec } from "../util/exec.js";
import { spawnInteractive } from "../util/spawn.js";

const WIN = process.platform === "win32";

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

  // A tickets file was given: preview (--dry-run) or create the issues.
  if (file) {
    const tickets = parseTickets(readFileSync(file, "utf8"));
    const plan = resolvePlan(tickets);

    // --dry-run: pure validate + preview, write nothing (no repo/config needed).
    if (opts.dryRun) {
      printPreview(plan);
      return;
    }
    // Refuse (with the preview) if there are blocking errors.
    if (plan.errors.length) {
      printPreview(plan);
      throw new Error(`refusing to create: ${plan.errors.length} error(s) in ${file}`);
    }
    loadConfig(cwd); // ensure an initialised orch repo before writing
    const created = await createFromPlan(tickets, cwd);
    console.log(pc.green(`Created ${created.length} issue(s):`));
    created.forEach((c) => console.log(`  #${c.number} ${c.title}${c.id ? pc.dim(` (${c.id})`) : ""}`));
    return;
  }

  if (opts.dryRun) throw new Error("--dry-run needs a tickets file (or use --draft/--example)");

  // No file and no flags: hand the terminal to an interactive Claude Code session.
  // It refines a plan with you and writes tickets.json; orch then validates it.
  const cfg = loadConfig(cwd);
  const adapter = cfg.adapters[cfg.lead];
  if (!adapter) throw new Error(`no adapter configured for lead '${cfg.lead}'`);
  ensurePlanSkill(cwd);

  const outputPath = resolve(cwd, "tickets.json");
  const before = existsSync(outputPath) ? statSync(outputPath).mtimeMs : 0;
  console.log(pc.bold("Launching an interactive Claude Code planning session…"));
  console.log(
    pc.dim(`Tell Claude what to build; when the plan looks right, ask it to save, then exit. Target: ${outputPath}`),
  );

  const seed = formatInteractiveSeed(outputPath);
  const { code } = await spawnInteractive(adapter.cmd, interactivePlanArgs(adapter.models?.hard, seed), {
    cwd,
    shell: WIN,
  });

  const written = existsSync(outputPath) && statSync(outputPath).mtimeMs > before;
  if (!written) {
    console.log(pc.yellow(`\nNo plan was written to ${outputPath} (session exited ${code}).`));
    console.log(pc.dim('Re-run `orch plan`, or `orch plan --draft "<goal>"` for a one-shot draft.'));
    return;
  }

  const plan = resolvePlan(parseTickets(readFileSync(outputPath, "utf8")));
  console.log("");
  printPreview(plan);
  console.log(pc.green(`\nSaved ${plan.tickets.length} ticket(s) to ${outputPath}.`));
  console.log(
    pc.dim("Next: `orch plan --dry-run tickets.json` (or the dashboard) to review, then `orch plan tickets.json` to create."),
  );
}
