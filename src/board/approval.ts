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

/** Heading of the non-blocking list a reviewer attaches to a verdict (ADR-0010 amendment). */
export const FOLLOWUPS_HEADING = "### Follow-ups (not required for this PR)";

const MAX_FOLLOWUPS = 10;
const MAX_FOLLOWUP_CHARS = 500;

/** A reviewer's `followups` value as a clean list: strings only, one line each, capped. Anything else is ignored. Pure. */
export function normalizeFollowups(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.replace(/\s+/g, " ").trim().slice(0, MAX_FOLLOWUP_CHARS))
    .filter((item) => item.length > 0)
    .slice(0, MAX_FOLLOWUPS);
}

/** The review note with its follow-ups appended as a fixed trailing section. Pure. */
export function withFollowups(notes: string, followups: readonly string[] = []): string {
  const list = normalizeFollowups([...followups]);
  const section = list.length ? [FOLLOWUPS_HEADING, ...list.map((item) => `- ${item}`)].join("\n") : "";
  return [notes.trim(), section].filter(Boolean).join("\n\n");
}

/** Split a recorded note into the part that asks for work and the follow-ups that do not. Pure. */
export function splitFollowups(notes: string): { notes: string; followups: string[] } {
  const at = notes.indexOf(FOLLOWUPS_HEADING);
  if (at < 0) return { notes: notes.trim(), followups: [] };
  const followups = notes
    .slice(at + FOLLOWUPS_HEADING.length)
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*-\s+/, "").trim())
    .filter(Boolean);
  return { notes: notes.slice(0, at).trim(), followups };
}

/** A recorded review's human-readable notes: its body without the trailing record marker. Pure. */
export function reviewNotes(review: PrReview): string {
  return review.body.replace(/\n*<!-- orch-review:v1 .* -->\s*$/, "").trim();
}

/**
 * The reviewer's notes (without any follow-ups) from the newest request-changes record bound to `head`, or null when
 * the latest decision on that head is not a request for changes. Pure.
 */
export function latestChangeRequestNotes(reviews: readonly PrReview[], pr: number, head: string): string | null {
  let latest: { notes: string; decision: ReviewRecord["decision"]; head: string } | null = null;
  for (const review of [...reviews].sort((a, b) => a.id - b.id)) {
    const r = parseReview(review);
    if (!r || r.pr !== pr) continue;
    // Follow-ups are recorded on the PR but are not feedback: they must never reach the author's fix prompt.
    latest = { decision: r.decision, head: r.head, notes: splitFollowups(reviewNotes(review)).notes };
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
