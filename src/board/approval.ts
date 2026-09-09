import type { PrReview } from "../github/github.js";

export interface ReviewRecord {
  reviewer: string;
  pr: number;
  head: string;
  timestamp: string;
  decision: "approve" | "request-changes";
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
      (r.decision === "approve" || r.decision === "request-changes") ? r : null;
  } catch { return null; }
}

/** Server review ids order decisions; client timestamps never determine precedence. */
export function currentReviewers(reviews: readonly PrReview[], pr: number, head: string): string[] {
  const approved = new Set<string>();
  for (const review of [...reviews].sort((a, b) => a.id - b.id)) {
    const r = parseReview(review);
    if (!r || r.pr !== pr) continue;
    if (r.decision === "request-changes") approved.clear();
    else if (r.head === head) approved.add(r.reviewer);
    else approved.delete(r.reviewer);
  }
  return [...approved];
}
