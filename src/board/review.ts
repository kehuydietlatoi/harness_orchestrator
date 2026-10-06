import {
  type Issue,
  type Pr,
  getPr,
  listIssues,
  listOpenPrs,
  getIssue,
  editIssue,
  listPrReviews,
  recordPrReview,
  prChecksPass,
  mergePr,
} from "../github/github.js";
import { STATUS, REVIEW_NEEDED, REVIEWED_BY_PREFIX, reviewedByLabel } from "../github/labels.js";
import { issueAgent, byNumber } from "./board.js";
import { release as lockRelease } from "../git/lock.js";
import { worktreePath, removeWorktree } from "../git/worktree.js";
import type { OrchConfig, ReviewPolicy } from "../config.js";
import { formatReview, reviewState, type ReviewMode } from "./approval.js";
import { assertSelfReviewAllowed } from "./reviewer.js";

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
  const [prs, open] = await Promise.all([
    listOpenPrs({ cwd }),
    listIssues({ cwd, state: "open" }).then(byNumber),
  ]);
  const items: ReviewItem[] = [];
  for (const pr of prs) {
    const n = prIssueNumber(pr);
    if (n === null) continue;
    const issue = open.get(n);
    if (!issue) continue;
    const author = issueAgent(issue);
    if (author === agent) continue; // never review your own work
    if (!issue.labels.includes(REVIEW_NEEDED)) {
      const review = reviewState(await listPrReviews(pr.number, { cwd }), pr.number, pr.headSha);
      if (review.changesRequested || review.reviewers.some((r) => r !== author)) continue;
      if (!review.staleApproval && !issue.labels.some((label) => label.startsWith(REVIEWED_BY_PREFIX))) continue;
    }
    items.push({ pr, issue, author });
  }
  return items;
}

/** How a review is being recorded; `self` needs the config to prove the fallback applies. */
export interface ReviewOpts {
  mode?: ReviewMode;
  cfg?: OrchConfig;
  /** Head the decision was made against; the write is refused if the PR has moved. */
  head?: string;
}

async function resolvePrIssue(
  prNum: number,
  agent: string,
  cwd: string,
  opts: ReviewOpts = {},
): Promise<{ issue: Issue; author: string | null; pr: Pr }> {
  const pr = await getPr(prNum, { cwd });
  const n = prIssueNumber(pr);
  if (n === null) throw new Error(`cannot map PR #${prNum} to an issue`);
  const issue = await getIssue(n, { cwd });
  const author = issueAgent(issue);
  if (opts.mode === "self") {
    if (author !== agent) throw new Error(`self-review must be recorded by the author '${author ?? "?"}', not '${agent}'.`);
    if (!opts.cfg) throw new Error("self-review requires the orch config to verify the fallback applies.");
    assertSelfReviewAllowed(agent, opts.cfg, cwd);
  } else if (author === agent) {
    throw new Error(`agent '${agent}' cannot review its own PR (authored by '${author}').`);
  }
  if (pr.state !== "OPEN" || !pr.headSha) throw new Error("review requires an open PR with a known head");
  return { issue, author, pr };
}

/** Record a cross-review approval by `agent`. */
export async function approve(
  prNum: number,
  agent: string,
  cwd: string,
  note = "",
  reviewedHead?: string,
  opts: ReviewOpts = {},
): Promise<{ issue: number; author: string | null }> {
  const { issue, author, pr } = await resolvePrIssue(prNum, agent, cwd, opts);
  if (!reviewedHead || reviewedHead !== pr.headSha) {
    throw new Error("pass --head with the full commit reviewed; the PR head must still match");
  }
  await recordPrReview(prNum, reviewedHead, formatReview({
    reviewer: agent, pr: prNum, head: reviewedHead, timestamp: new Date().toISOString(), decision: "approve",
    ...(opts.mode === "self" ? { mode: "self" as const } : {}),
  }, note || `Approved by ${agent} via orch.`), { cwd });
  await editIssue(issue.number, {
    cwd,
    addLabels: [reviewedByLabel(agent)],
    removeLabels: [REVIEW_NEEDED],
  });
  return { issue: issue.number, author };
}

/** Request changes: bounce the issue back to its author. */
export async function requestChanges(
  prNum: number,
  agent: string,
  cwd: string,
  note: string,
  opts: ReviewOpts = {},
): Promise<{ issue: number; author: string | null }> {
  const { issue, author, pr } = await resolvePrIssue(prNum, agent, cwd, opts);
  if (opts.head && opts.head !== pr.headSha) throw new Error("the PR head changed since it was reviewed; review it again");
  await recordPrReview(prNum, pr.headSha, formatReview({
    reviewer: agent, pr: prNum, head: pr.headSha, timestamp: new Date().toISOString(), decision: "request-changes",
    ...(opts.mode === "self" ? { mode: "self" as const } : {}),
  }, note), { cwd });
  await editIssue(issue.number, {
    cwd,
    addLabels: [STATUS.inProgress],
    removeLabels: [REVIEW_NEEDED, STATUS.inReview, ...issue.labels.filter((l) => l.startsWith(REVIEWED_BY_PREFIX))],
  });
  return { issue: issue.number, author };
}

export interface GateResult {
  head: string;
  ok: boolean;
  reasons: string[];
  issue: number | null;
  author: string | null;
}

/**
 * Does the current head carry an acceptable approval? Either the other harness approved
 * it, or - under `cross-or-self` - its author's own fresh session did and the record is
 * marked `self` (an unmarked author approval never counts). Pure; shared by the merge gate
 * and the autonomous loop so they cannot disagree about what "approved" means.
 */
export function reviewSatisfied(params: {
  author: string | null;
  reviewers: readonly string[];
  selfReviewers?: readonly string[];
  reviewPolicy?: ReviewPolicy;
  agents: readonly string[];
}): boolean {
  const cross = params.reviewers.some((r) => r !== params.author && params.agents.includes(r));
  const self =
    params.reviewPolicy === "cross-or-self" &&
    params.author !== null &&
    params.agents.includes(params.author) &&
    (params.selfReviewers ?? []).includes(params.author);
  return cross || self;
}

/**
 * Pure gate decision (no I/O) — the core policy, unit-tested in isolation.
 * Returns the list of blocking reasons; empty means "may merge".
 */
export function evaluateGate(params: {
  author: string | null;
  reviewers: string[];
  /** Reviewers whose current approval was a fallback self-review. */
  selfReviewers?: string[];
  reviewPolicy?: ReviewPolicy;
  agents: string[];
  requireCrossReview: boolean;
  checksPass: boolean;
  checksDetail: string;
  requireHumanMerge: boolean;
  humanApproved: boolean;
}): string[] {
  const reasons: string[] = [];
  if (params.requireCrossReview) {
    if (!reviewSatisfied(params)) {
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
    return { ok: false, reasons: ["cannot map PR to an issue"], issue: null, author: null, head: pr.headSha };
  }
  const issue = await getIssue(n, { cwd });
  const author = issueAgent(issue);
  const approvals = cfg.requireCrossReview
    ? reviewState(await listPrReviews(prNum, { cwd }), prNum, pr.headSha) : null;
  if (pr.state !== "OPEN" || !pr.headSha) reasons.push("PR must be open with a known head");
  if (cfg.requireCrossReview && (!author || !cfg.agents.includes(author))) reasons.push("PR author must be a configured harness");
  const checks = await prChecksPass(prNum, { cwd });

  reasons.push(
    ...evaluateGate({
      author,
      reviewers: approvals?.reviewers ?? [],
      selfReviewers: approvals?.selfReviewers ?? [],
      reviewPolicy: cfg.reviewPolicy,
      agents: cfg.agents,
      requireCrossReview: cfg.requireCrossReview,
      checksPass: checks.pass,
      checksDetail: checks.detail,
      requireHumanMerge: cfg.requireHumanMerge,
      humanApproved,
    }),
  );

  return { ok: reasons.length === 0, reasons, issue: n, author, head: pr.headSha };
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
  await mergePr(prNum, { cwd, method: "squash", expectedHead: gate.head });

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
