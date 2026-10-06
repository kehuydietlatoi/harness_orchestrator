import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import pc from "picocolors";
import { configExists, loadConfig, resolveLeadModel } from "../config.js";
import { makeAdapter } from "../adapters/index.js";
import { parseTickets, resolvePlan, type ResolvedPlan } from "../tasks/plan.js";
import { createFromPlan, type Created, type Failed } from "../tasks/plan-create.js";
import {
  ensurePlanSkill,
  formatInteractiveSeed,
  loadPlanSkill,
  runInteractivePlanner,
  runPlanner,
} from "../tasks/planner.js";
import { exec } from "../util/exec.js";

export interface PlanOptions {
  draft?: string;
  dryRun?: boolean;
  example?: boolean;
  /** Path to a plan brief (markdown) embedded in every created issue as "Plan context". */
  brief?: string;
}

/** File the interactive session writes the brainstorm's reasoning to, next to tickets.json. */
export const BRIEF_FILE = "plan-brief.md";

function readBrief(path: string | undefined): string | undefined {
  if (!path) return undefined;
  return readFileSync(path, "utf8").replace(/^\uFEFF/, ""); // tolerate a UTF-8 BOM
}

/** Shallow repo context (tracked files) so the planner produces realistic file hints. */
async function repoContext(cwd: string): Promise<string> {
  const r = await exec("git", ["ls-files"], { cwd });
  if (r.code !== 0) return "";
  const files = r.stdout.split(/\r?\n/).filter(Boolean).slice(0, 200);
  return files.length ? `Repository files:\n${files.join("\n")}` : "";
}

/** Render a resolved plan for humans: the issues that would be created, plus warnings/errors. */
function printPreview(plan: ResolvedPlan, brief?: string): void {
  console.log(pc.bold(`Would create ${plan.tickets.length} issue(s):`));
  for (const t of plan.tickets) {
    const meta = [
      t.id && `id:${t.id}`,
      t.agent && `route:${t.agent}${t.effort ? `/${t.effort}` : ""}`,
      t.knownDeps.length && `deps:${t.knownDeps.join(",")}`,
      t.knownAfter.length && `after (advisory):${t.knownAfter.join(",")}`,
      t.files.length && `files:${t.files.join(", ")}`,
    ]
      .filter(Boolean)
      .join("  ");
    console.log(`  ${t.index}. ${t.title}${meta ? pc.dim(`  (${meta})`) : ""}`);
  }
  const unrouted = plan.tickets.filter((t) => !t.agent).length;
  if (unrouted) console.log(pc.dim(`  ${unrouted} ticket(s) unrouted: \`orch assign --auto\` routes them after creation`));
  const words = brief?.trim() ? brief.trim().split(/\s+/).length : 0;
  console.log(pc.dim(words ? `  plan brief: ${words} words, embedded in every issue` : "  plan brief: none"));
  plan.warnings.forEach((w) => console.log(pc.yellow(`  warning: ${w}`)));
  plan.errors.forEach((e) => console.log(pc.red(`  error: ${e}`)));
  if (!plan.errors.length) console.log(pc.dim("  (dry run — no issues created)"));
}

function printIssueResults(label: string, issues: readonly Created[], color: (text: string) => string): void {
  console.log(color(`${label} ${issues.length} issue(s):`));
  issues.forEach((issue) =>
    console.log(`  #${issue.number} ${issue.title}${issue.id ? pc.dim(` (${issue.id})`) : ""}`),
  );
}

function printFailures(failed: readonly Failed[]): void {
  console.log(pc.red(`Failed ${failed.length} issue(s):`));
  failed.forEach((item) => console.log(`  ${item.title}${item.id ? pc.dim(` (${item.id})`) : ""}: ${item.error}`));
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
    const brief = readBrief(opts.brief);
    // Agents come from config when there is one; a bare --dry-run needs no repo.
    const agents = opts.dryRun && !configExists(cwd) ? undefined : loadConfig(cwd).agents;
    const plan = resolvePlan(tickets, { agents, brief });

    // --dry-run: pure validate + preview, write nothing (no repo/config needed).
    if (opts.dryRun) {
      printPreview(plan, brief);
      return;
    }
    // Refuse (with the preview) if there are blocking errors.
    if (plan.errors.length) {
      printPreview(plan, brief);
      throw new Error(`refusing to create: ${plan.errors.length} error(s) in ${file}`);
    }
    const result = await createFromPlan(tickets, cwd, undefined, { agents, brief });
    printIssueResults("Created", result.created, pc.green);
    printIssueResults("Reused", result.reused, pc.cyan);
    printFailures(result.failed);
    if (result.failed.length) process.exitCode = 1;
    return;
  }

  if (opts.dryRun) throw new Error("--dry-run needs a tickets file (or use --draft/--example)");

  // No file and no flags: use the lead adapter's optional interactive planning
  // capability. It writes tickets.json; orch then validates it.
  const cfg = loadConfig(cwd);
  const adapter = makeAdapter(cfg.lead, cfg);
  if (!adapter.runInteractivePlan) {
    throw new Error(
      `lead adapter '${adapter.id}' does not support interactive planning; use \`orch plan --draft "<goal>"\` instead`,
    );
  }
  ensurePlanSkill(cwd);

  const outputPath = resolve(cwd, "tickets.json");
  const briefPath = resolve(cwd, BRIEF_FILE);
  const before = existsSync(outputPath) ? statSync(outputPath).mtimeMs : 0;
  const started = Date.now();
  console.log(pc.bold(`Launching an interactive ${adapter.id} planning session…`));
  console.log(
    pc.dim(`Tell ${adapter.id} what to build; when the plan looks right, ask it to save, then exit. Target: ${outputPath}`),
  );

  const seed = formatInteractiveSeed(outputPath, briefPath, cfg.agents);
  const { code } = await runInteractivePlanner(adapter, {
    cwd,
    seed,
    model: resolveLeadModel(cfg),
  });

  const written = existsSync(outputPath) && statSync(outputPath).mtimeMs > before;
  if (!written) {
    console.log(pc.yellow(`\nNo plan was written to ${outputPath} (session exited ${code}).`));
    console.log(pc.dim('Re-run `orch plan`, or `orch plan --draft "<goal>"` for a one-shot draft.'));
    return;
  }

  // Only a brief this session wrote belongs to this plan; an older file is a previous plan's.
  const briefWritten = existsSync(briefPath) && statSync(briefPath).mtimeMs >= started;
  const brief = briefWritten ? readBrief(briefPath) : undefined;
  const plan = resolvePlan(parseTickets(readFileSync(outputPath, "utf8")), { agents: cfg.agents, brief });
  console.log("");
  printPreview(plan, brief);
  console.log(pc.green(`\nSaved ${plan.tickets.length} ticket(s) to ${outputPath}${briefWritten ? ` and the brief to ${briefPath}` : ""}.`));
  const briefArg = briefWritten ? ` --brief ${BRIEF_FILE}` : "";
  console.log(
    pc.dim(`Next: \`orch plan --dry-run tickets.json${briefArg}\` (or the dashboard) to review, then \`orch plan tickets.json${briefArg}\` to create.`),
  );
}
