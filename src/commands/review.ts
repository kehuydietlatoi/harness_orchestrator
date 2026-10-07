import pc from "picocolors";
import { loadConfig } from "../config.js";
import { runAutomatedReview } from "../board/review-run.js";
import { resolveAgent } from "../tasks/service.js";
import { prDiff } from "../github/github.js";
import {
  reviewQueue,
  approve,
  requestChanges,
  prIssueNumber,
} from "../board/review.js";
import { getPr } from "../github/github.js";

function parsePr(arg: string): number {
  const n = Number(arg);
  if (!Number.isInteger(n)) throw new Error(`invalid PR number: ${arg}`);
  return n;
}

export async function reviewQueueCommand(opts: { agent?: string }): Promise<void> {
  const cwd = process.cwd();
  const cfg = loadConfig(cwd);
  const agent = resolveAgent(opts.agent, cfg);

  const items = await reviewQueue(agent, cwd, cfg.reviewPolicy);
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
  const after = await getPr(prNum, { cwd });
  if (after.headSha !== pr.headSha) throw new Error("PR changed while reading the diff; run review again");
  console.log(`Reviewed head: ${pr.headSha}`);
  console.log(pc.bold("\nReview checklist:"));
  console.log("  - Does it satisfy the issue's acceptance criteria?");
  console.log("  - Correctness, tests, and edge cases?");
  console.log("  - No unrelated/out-of-scope changes?");
  console.log(
    pc.dim(
      `\nThen: orch review-approve ${prNum} --agent ${agent} --head ${pr.headSha}` +
        `   |   orch review-changes ${prNum} --agent ${agent} --notes "…"`,
    ),
  );
}

/** Run a read-only headless review end to end (reviewer auto-picked, with self-review fallback). */
export async function reviewRunCommand(prArg: string, opts: { agent?: string }): Promise<void> {
  const cwd = process.cwd();
  const cfg = loadConfig(cwd);
  const prNum = parsePr(prArg);

  const out = await runAutomatedReview(prNum, cfg, cwd, { reviewer: opts.agent });
  const how = out.mode === "self" ? "self-review fallback in a fresh session" : "cross-review";
  if (out.decision === "approve") {
    console.log(pc.green(`PR #${prNum} approved by '${out.reviewer}' (${how}, issue #${out.issue}).`));
    console.log(pc.dim("`orch merge` will accept it once CI is green."));
  } else {
    console.log(pc.yellow(`PR #${prNum}: changes requested by '${out.reviewer}' (${how}).`));
    console.log(pc.dim(`Issue #${out.issue} bounced back to '${out.author}' (status:in-progress).
${out.notes}`));
  }
  if (out.followups.length) {
    console.log(pc.dim(`Recorded ${out.followups.length} non-blocking follow-up(s) on the PR:`));
    out.followups.forEach((item) => console.log(pc.dim(`  - ${item}`)));
  }
}

export async function reviewApproveCommand(prArg: string, opts: { agent?: string; notes?: string; head?: string; self?: boolean }): Promise<void> {
  const cwd = process.cwd();
  const cfg = loadConfig(cwd);
  const agent = resolveAgent(opts.agent, cfg);
  const prNum = parsePr(prArg);

  const { issue, author } = await approve(prNum, agent, cwd, opts.notes ?? "", opts.head,
    opts.self ? { mode: "self", cfg } : {});
  console.log(pc.green(`PR #${prNum} approved by '${agent}' (issue #${issue}, authored by '${author}').`));
  console.log(pc.dim("Cross-review satisfied — `orch merge` will now accept this PR (if CI is green)."));
}

export async function reviewChangesCommand(
  prArg: string,
  opts: { agent?: string; notes?: string; self?: boolean },
): Promise<void> {
  const cwd = process.cwd();
  const cfg = loadConfig(cwd);
  const agent = resolveAgent(opts.agent, cfg);
  const prNum = parsePr(prArg);
  if (!opts.notes) throw new Error("--notes is required to request changes");

  const { issue, author } = await requestChanges(prNum, agent, cwd, opts.notes, opts.self ? { mode: "self", cfg } : {});
  console.log(pc.yellow(`PR #${prNum}: changes requested by '${agent}'.`));
  console.log(pc.dim(`Issue #${issue} bounced back to author '${author}' (status:in-progress).`));
}
