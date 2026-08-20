import pc from "picocolors";
import { loadConfig } from "../config.js";
import { resolveAgent } from "../service.js";
import { prDiff } from "../github.js";
import {
  reviewQueue,
  approve,
  requestChanges,
  prIssueNumber,
} from "../review.js";
import { getPr } from "../github.js";

function parsePr(arg: string): number {
  const n = Number(arg);
  if (!Number.isInteger(n)) throw new Error(`invalid PR number: ${arg}`);
  return n;
}

export async function reviewQueueCommand(opts: { agent?: string }): Promise<void> {
  const cwd = process.cwd();
  const cfg = loadConfig(cwd);
  const agent = resolveAgent(opts.agent, cfg);

  const items = await reviewQueue(agent, cwd);
  console.log(pc.bold(`Review queue for '${agent}'\n`));
  if (!items.length) {
    console.log(pc.dim("  (nothing awaiting your review)"));
    return;
  }
  for (const it of items) {
    console.log(`  PR #${it.pr.number} — ${it.pr.title} ${pc.dim(`(issue #${it.issue.number}, by ${it.author})`)}`);
  }
  console.log(pc.dim(`\nReview one with: orch review <pr> --agent ${agent}`));
}

export async function reviewCommand(prArg: string, opts: { agent?: string }): Promise<void> {
  const cwd = process.cwd();
  const cfg = loadConfig(cwd);
  const agent = resolveAgent(opts.agent, cfg);
  const prNum = parsePr(prArg);

  const pr = await getPr(prNum, { cwd });
  const issue = prIssueNumber(pr);
  console.log(pc.bold(`PR #${pr.number}: ${pr.title}`) + pc.dim(` (issue #${issue ?? "?"})\n`));
  console.log(await prDiff(prNum, { cwd }));
  console.log(pc.bold("\nReview checklist:"));
  console.log("  - Does it satisfy the issue's acceptance criteria?");
  console.log("  - Correctness, tests, and edge cases?");
  console.log("  - No unrelated/out-of-scope changes?");
  console.log(
    pc.dim(
      `\nThen: orch review-approve ${prNum} --agent ${agent}` +
        `   |   orch review-changes ${prNum} --agent ${agent} --notes "…"`,
    ),
  );
}

export async function reviewApproveCommand(prArg: string, opts: { agent?: string; notes?: string }): Promise<void> {
  const cwd = process.cwd();
  const cfg = loadConfig(cwd);
  const agent = resolveAgent(opts.agent, cfg);
  const prNum = parsePr(prArg);

  const { issue, author } = await approve(prNum, agent, cwd, opts.notes ?? "");
  console.log(pc.green(`PR #${prNum} approved by '${agent}' (issue #${issue}, authored by '${author}').`));
  console.log(pc.dim("Cross-review satisfied — `orch merge` will now accept this PR (if CI is green)."));
}

export async function reviewChangesCommand(
  prArg: string,
  opts: { agent?: string; notes?: string },
): Promise<void> {
  const cwd = process.cwd();
  const cfg = loadConfig(cwd);
  const agent = resolveAgent(opts.agent, cfg);
  const prNum = parsePr(prArg);
  if (!opts.notes) throw new Error("--notes is required to request changes");

  const { issue, author } = await requestChanges(prNum, agent, cwd, opts.notes);
  console.log(pc.yellow(`PR #${prNum}: changes requested by '${agent}'.`));
  console.log(pc.dim(`Issue #${issue} bounced back to author '${author}' (status:in-progress).`));
}
