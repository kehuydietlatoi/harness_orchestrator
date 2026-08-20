import pc from "picocolors";
import { loadConfig } from "../config.js";
import { listOpenPrs } from "../github.js";
import { checkMergeGate, merge, prIssueNumber } from "../review.js";

function parsePr(arg: string): number {
  const n = Number(arg);
  if (!Number.isInteger(n)) throw new Error(`invalid PR number: ${arg}`);
  return n;
}

export async function mergeCommand(prArg: string, opts: { human?: boolean }): Promise<void> {
  const cwd = process.cwd();
  const cfg = loadConfig(cwd);
  const prNum = parsePr(prArg);

  const { issue } = await merge(prNum, cfg, cwd, opts.human ?? false);
  console.log(pc.green(`Merged PR #${prNum}.`) + (issue !== null ? ` Closed issue #${issue}.` : ""));
  console.log(pc.dim("Lock released, worktree pruned."));
}

export async function integrateCommand(opts: { human?: boolean }): Promise<void> {
  const cwd = process.cwd();
  const cfg = loadConfig(cwd);

  const prs = await listOpenPrs({ cwd });
  console.log(pc.bold(`orch integrate — ${prs.length} open PR(s)\n`));

  let merged = 0;
  for (const pr of prs) {
    if (prIssueNumber(pr) === null) continue;
    const gate = await checkMergeGate(pr.number, cfg, cwd, opts.human ?? false);
    if (!gate.ok) {
      console.log(pc.yellow(`  ⏭  PR #${pr.number} skipped:`));
      gate.reasons.forEach((r) => console.log(pc.dim(`       - ${r}`)));
      continue;
    }
    await merge(pr.number, cfg, cwd, opts.human ?? false);
    merged++;
    console.log(pc.green(`  ✓ merged PR #${pr.number} (issue #${gate.issue})`));
  }
  console.log(pc.bold(`\nMerged ${merged} PR(s).`));
}
