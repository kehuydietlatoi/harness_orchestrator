import type { ReviewPolicy } from "../config.js";
import type { PrReview } from "../github/github.js";

export type ReviewMode = "cross" | "self";

export interface ReviewRecord {
  reviewer: string;
  pr: number;
  head: string;
  timestamp: string;
  decision: "approve" | "request-changes";
  /** Absent on cross-reviews (and every record written before self-review existed). */
  mode?: ReviewMode;
}

export function formatReview(record: ReviewRecord, note: string): string {
  return `${note}\n\n<!-- orch-review:v1 ${JSON.stringify(record)} -->`;
}

/** Read only a complete, commit-bound record from a submitted native review. */
export function parseReview(review: PrReview): ReviewRecord | null {
  if (review.state !== "COMMENTED") return null;
  const match = review.body.match(/\n<!-- orch-review:v1 (.+) -->\s*$/);
  if (!match) return null;
  try {
    const r = JSON.parse(match[1]) as ReviewRecord;
    return typeof r.reviewer === "string" && r.reviewer.length > 0 &&
      Number.isSafeInteger(r.pr) && r.pr > 0 && typeof r.head === "string" &&
      /^[a-f0-9]{40,64}$/.test(r.head) && r.head === review.commit_id &&
      typeof r.timestamp === "string" && Number.isFinite(Date.parse(r.timestamp)) &&
      (r.decision === "approve" || r.decision === "request-changes") &&
      (r.mode === undefined || r.mode === "cross" || r.mode === "self") ? r : null;
  } catch { return null; }
}

/** Server review ids order decisions; client timestamps never determine precedence. */
export function currentReviewers(reviews: readonly PrReview[], pr: number, head: string): string[] {
  return reviewState(reviews, pr, head).reviewers;
}

/** Shared head-bound review facts for the gate, queue, repair, and board. */
export function reviewState(reviews: readonly PrReview[], pr: number, head: string): {
  reviewers: string[];
  /** Subset of `reviewers` whose current approval was a fallback self-review. */
  selfReviewers: string[];
  changesRequested: boolean;
  staleApproval: boolean;
} {
  const approved = new Map<string, { head: string; mode?: ReviewMode }>();
  let latest: ReviewRecord | null = null;
  for (const review of [...reviews].sort((a, b) => a.id - b.id)) {
    const r = parseReview(review);
    if (!r || r.pr !== pr) continue;
    latest = r;
    if (r.decision === "request-changes") approved.clear();
    else approved.set(r.reviewer, { head: r.head, mode: r.mode });
  }
  const current = [...approved].filter(([, a]) => a.head === head);
  return {
    reviewers: current.map(([reviewer]) => reviewer),
    selfReviewers: current.filter(([, a]) => a.mode === "self").map(([reviewer]) => reviewer),
    changesRequested: latest?.decision === "request-changes" && latest.head === head,
    staleApproval: [...approved.values()].some((a) => a.head !== head),
  };
}

/**
 * Fix rounds already *answered*, from the PR's own durable history: the number of distinct earlier heads
 * that drew a change request. A request on `currentHead` has not been answered yet, so it is not counted,
 * and several requests on one unchanged head (a second reviewer, a repeated review) still ask for a single
 * fix, so they are counted once. A head only stops being "current" when a fix was pushed.
 */
export function answeredChangeRequestRounds(reviews: readonly PrReview[], pr: number, currentHead: string): number {
  const heads = new Set<string>();
  for (const review of reviews) {
    const r = parseReview(review);
    if (r && r.pr === pr && r.decision === "request-changes" && r.head !== currentHead) heads.add(r.head);
  }
  return heads.size;
}

/** A recorded review's human-readable notes: its body without the trailing record marker. Pure. */
export function reviewNotes(review: PrReview): string {
  return review.body.replace(/\n*<!-- orch-review:v1 .* -->\s*$/, "").trim();
}

/**
 * The reviewer's notes from the newest request-changes record bound to `head`, or null when
 * the latest decision on that head is not a request for changes. Pure.
 */
export function latestChangeRequestNotes(reviews: readonly PrReview[], pr: number, head: string): string | null {
  let latest: { notes: string; decision: ReviewRecord["decision"]; head: string } | null = null;
  for (const review of [...reviews].sort((a, b) => a.id - b.id)) {
    const r = parseReview(review);
    if (!r || r.pr !== pr) continue;
    latest = { decision: r.decision, head: r.head, notes: reviewNotes(review) };
  }
  return latest && latest.decision === "request-changes" && latest.head === head ? latest.notes : null;
}

/**
 * Which of a head's current approvers actually count, under `policy`. The one definition shared by the merge
 * gate's view of "approved", the review queue, `repair`'s label projection, and the board, so they cannot
 * disagree about the same PR. Another harness always counts. The author counts only as a *marked* fallback
 * self-review (`mode: "self"`) and only under `cross-or-self`; an unmarked author approval never does. With no
 * policy given, only cross-review counts (the original, strict behaviour).
 */
export function acceptedReviewers(
  state: { reviewers: readonly string[]; selfReviewers: readonly string[] },
  author: string | null,
  policy?: ReviewPolicy,
): string[] {
  return state.reviewers.filter(
    (reviewer) => reviewer !== author || (policy === "cross-or-self" && state.selfReviewers.includes(reviewer)),
  );
}
