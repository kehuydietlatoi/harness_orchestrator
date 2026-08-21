import {
  type Issue,
  type Pr,
  getPr,
  listOpenPrs,
  getIssue,
  editIssue,
  reviewPr,
  prChecksPass,
  mergePr,
} from "./github.js";
import { STATUS, REVIEW_NEEDED, REVIEWED_BY_PREFIX, reviewedByLabel } from "./labels.js";
import { issueAgent } from "./board.js";
import { release as lockRelease } from "./lock.js";
import { worktreePath, removeWorktree } from "./worktree.js";
import type { OrchConfig } from "./config.js";

/** Map a PR back to its issue via the `task/<n>-` branch or a `Closes #n` line. */
export function prIssueNumber(pr: Pick<Pr, "headRefName" | "body">): number | null {
  const byBranch = pr.headRefName.match(/^task\/(\d+)-/);
  if (byBranch) return Number(byBranch[1]);
  const byBody = pr.body.match(/closes\s+#(\d+)/i);
  return byBody ? Number(byBody[1]) : null;
}

export interface ReviewItem {
  pr: Pr;
  issue: Issue;
  author: string | null;
}

/** PRs awaiting review by `agent` (needs review, and not authored by that agent). */
export async function reviewQueue(agent: string, cwd: string): Promise<ReviewItem[]> {
  const items: ReviewItem[] = [];
  for (const pr of await listOpenPrs({ cwd })) {
    const n = prIssueNumber(pr);
    if (n === null) continue;
    const issue = await getIssue(n, { cwd });
    if (!issue.labels.includes(REVIEW_NEEDED)) continue;
    const author = issueAgent(issue);
    if (author === agent) continue; // never review your own work
    items.push({ pr, issue, author });
  }
  return items;
}

async function resolvePrIssue(
  prNum: number,
  agent: string,
  cwd: string,
): Promise<{ issue: Issue; author: string | null }> {
  const pr = await getPr(prNum, { cwd });
  const n = prIssueNumber(pr);
  if (n === null) throw new Error(`cannot map PR #${prNum} to an issue`);
  const issue = await getIssue(n, { cwd });
  const author = issueAgent(issue);
  if (author === agent) {
    throw new Error(`agent '${agent}' cannot review its own PR (authored by '${author}').`);
  }
  return { issue, author };
}

/** Record a cross-review approval by `agent`. */
export async function approve(
  prNum: number,
  agent: string,
  cwd: string,
  note = "",
): Promise<{ issue: number; author: string | null }> {
  const { issue, author } = await resolvePrIssue(prNum, agent, cwd);
  await editIssue(issue.number, {
    cwd,
    addLabels: [reviewedByLabel(agent)],
    removeLabels: [REVIEW_NEEDED],
  });
  await reviewPr(prNum, "approve", note || `Approved by \`${agent}\` via orch.`, { cwd });
  return { issue: issue.number, author };
}

/** Request changes: bounce the issue back to its author. */
export async function requestChanges(
  prNum: number,
  agent: string,
  cwd: string,
  note: string,
): Promise<{ issue: number; author: string | null }> {
  const { issue, author } = await resolvePrIssue(prNum, agent, cwd);
  await editIssue(issue.number, {
    cwd,
    addLabels: [STATUS.inProgress],
    removeLabels: [REVIEW_NEEDED, STATUS.inReview],
  });
  await reviewPr(prNum, "request-changes", note, { cwd });
  return { issue: issue.number, author };
}

export interface GateResult {
  ok: boolean;
  reasons: string[];
  issue: number | null;
  author: string | null;
}

/**
 * Pure gate decision (no I/O) — the core policy, unit-tested in isolation.
 * Returns the list of blocking reasons; empty means "may merge".
 */
export function evaluateGate(params: {
  author: string | null;
  reviewers: string[];
  agents: string[];
  requireCrossReview: boolean;
  checksPass: boolean;
  checksDetail: string;
  requireHumanMerge: boolean;
  humanApproved: boolean;
}): string[] {
  const reasons: string[] = [];
  if (params.requireCrossReview) {
    const cross = params.reviewers.find((r) => r !== params.author && params.agents.includes(r));
    if (!cross) {
      reasons.push(
        `needs approval from the other harness (author='${params.author ?? "?"}', reviewers=[${params.reviewers.join(", ") || "none"}])`,
      );
    }
  }
  if (!params.checksPass) reasons.push(`CI not green: ${params.checksDetail}`);
  if (params.requireHumanMerge && !params.humanApproved) {
    reasons.push("requireHumanMerge is on — pass --human to confirm");
  }
  return reasons;
}

/** The heart of P3: decide whether a PR may merge. */
export async function checkMergeGate(
  prNum: number,
  cfg: OrchConfig,
  cwd: string,
  humanApproved = false,
): Promise<GateResult> {
  const reasons: string[] = [];
  const pr = await getPr(prNum, { cwd });
  const n = prIssueNumber(pr);
  if (n === null) {
    return { ok: false, reasons: ["cannot map PR to an issue"], issue: null, author: null };
  }
  const issue = await getIssue(n, { cwd });
  const author = issueAgent(issue);
  const reviewers = issue.labels
    .filter((l) => l.startsWith(REVIEWED_BY_PREFIX))
    .map((l) => l.slice(REVIEWED_BY_PREFIX.length));
  const checks = await prChecksPass(prNum, { cwd });

  reasons.push(
    ...evaluateGate({
      author,
      reviewers,
      agents: cfg.agents,
      requireCrossReview: cfg.requireCrossReview,
      checksPass: checks.pass,
      checksDetail: checks.detail,
      requireHumanMerge: cfg.requireHumanMerge,
      humanApproved,
    }),
  );

  return { ok: reasons.length === 0, reasons, issue: n, author };
}

/** Merge a PR through the gate, then prune the worktree and release the lock. */
export async function merge(
  prNum: number,
  cfg: OrchConfig,
  cwd: string,
  humanApproved = false,
): Promise<{ issue: number | null }> {
  const gate = await checkMergeGate(prNum, cfg, cwd, humanApproved);
  if (!gate.ok) {
    throw new Error(`merge blocked for PR #${prNum}:\n  - ${gate.reasons.join("\n  - ")}`);
  }
  await mergePr(prNum, { cwd, method: "squash", deleteBranch: true });

  if (gate.issue !== null) {
    await removeWorktree(worktreePath(cfg.worktreeRoot, gate.issue, cwd), { cwd });
  }

  if (gate.issue !== null) {
    await lockRelease(gate.issue, { cwd });
    try {
      await editIssue(gate.issue, {
        cwd,
        addLabels: [STATUS.done],
        removeLabels: [STATUS.inReview],
      });
    } catch {
      /* issue already closed by "Closes #n"; labelling is best-effort */
    }
  }
  return { issue: gate.issue };
}
