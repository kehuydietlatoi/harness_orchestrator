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

/** How many times changes were requested on this PR, across every head. Durable round evidence. */
export function countChangeRequests(reviews: readonly PrReview[], pr: number): number {
  let n = 0;
  for (const review of reviews) {
    const r = parseReview(review);
    if (r && r.pr === pr && r.decision === "request-changes") n += 1;
  }
  return n;
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
    latest = { decision: r.decision, head: r.head, notes: review.body.replace(/\n*<!-- orch-review:v1 .* -->\s*$/, "").trim() };
  }
  return latest && latest.decision === "request-changes" && latest.head === head ? latest.notes : null;
}
