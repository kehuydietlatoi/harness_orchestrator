import { describe, expect, it } from "vitest";
import { currentReviewers, formatReview, parseReview, reviewState, type ReviewRecord } from "../src/board/approval.js";
const head = "a".repeat(40);
function review(id = 1, changes: Partial<ReviewRecord> = {}) {
  const record: ReviewRecord = { reviewer: "claude", pr: 62, head,
    timestamp: "2026-09-09T12:00:00Z", decision: "approve", ...changes };
  return { id, state: "COMMENTED", commit_id: record.head, body: formatReview(record, "Reviewed") };
}
describe("commit-bound review decisions", () => {
  it("accepts only the current PR and head", () => {
    expect(currentReviewers([review()], 62, head)).toEqual(["claude"]);
    expect(currentReviewers([review()], 62, "b".repeat(40))).toEqual([]);
    expect(currentReviewers([review()], 63, head)).toEqual([]);
  });
  it("revokes previous approvals on changes requested, ordered by server id", () => {
    expect(currentReviewers([review(2, { decision: "request-changes" }), review()], 62, head)).toEqual([]);
    expect(currentReviewers([review(), review(2, { decision: "request-changes" }), review(3)], 62, head)).toEqual(["claude"]);
  });
  it("tracks which current approvals are fallback self-reviews", () => {
    const state = reviewState([review(1, { mode: "self" }), review(2, { reviewer: "codex" })], 62, head);
    expect(state.reviewers).toEqual(["claude", "codex"]);
    expect(state.selfReviewers).toEqual(["claude"]);
    expect(reviewState([review(1, { mode: "cross" })], 62, head).selfReviewers).toEqual([]);
    expect(reviewState([review(1, { mode: "self" })], 62, "b".repeat(40)).selfReviewers).toEqual([]);
  });
  it("rejects an unknown review mode but accepts the known ones and none", () => {
    expect(parseReview(review(1, { mode: "self" }))).not.toBeNull();
    expect(parseReview(review(1, { mode: "cross" }))).not.toBeNull();
    expect(parseReview(review(1))).not.toBeNull();
    expect(parseReview(review(1, { mode: "bogus" as never }))).toBeNull();
  });
  it("rejects malformed, dismissed, unbound, and legacy records", () => {
    for (const candidate of [
      { ...review(), body: "Approved by claude" },
      { ...review(), state: "DISMISSED" },
      { ...review(), body: "\n<!-- orch-review:v1 { -->" },
      { ...review(), commit_id: "b".repeat(40) },
      review(1, { timestamp: "bad" }), review(1, { head: "" }),
    ]) expect(parseReview(candidate)).toBeNull();
  });
});
