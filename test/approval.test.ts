import { describe, expect, it } from "vitest";
import {
  acceptedReviewers, FOLLOWUPS_HEADING, currentReviewers, formatReview, latestChangeRequestNotes, normalizeFollowups, parseReview, reviewNotes,
  reviewState, splitFollowups, withFollowups, type ReviewRecord,
} from "../src/board/approval.js";
import { evaluateGate } from "../src/board/review.js";
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

describe("review follow-ups", () => {
  it("normalizes a reviewer's follow-ups: strings only, one line, capped, never throwing", () => {
    expect(normalizeFollowups(["  more\n cases ", "", 3, null, "rename it"])).toEqual(["more cases", "rename it"]);
    expect(normalizeFollowups("not a list")).toEqual([]);
    expect(normalizeFollowups(undefined)).toEqual([]);
    expect(normalizeFollowups(Array.from({ length: 25 }, (_, i) => `item ${i}`))).toHaveLength(10);
    expect(normalizeFollowups(["x".repeat(900)])[0]).toHaveLength(500);
  });

  it("appends a fixed trailing section and splits it back off", () => {
    const note = withFollowups("Meets the criteria.", ["more cases", "rename it"]);
    expect(note).toBe(`Meets the criteria.\n\n${FOLLOWUPS_HEADING}\n- more cases\n- rename it`);
    expect(splitFollowups(note)).toEqual({ notes: "Meets the criteria.", followups: ["more cases", "rename it"] });
    expect(withFollowups("Plain note.")).toBe("Plain note.");
    expect(withFollowups("", ["only a follow-up"])).toBe(`${FOLLOWUPS_HEADING}\n- only a follow-up`);
    expect(splitFollowups("Plain note.")).toEqual({ notes: "Plain note.", followups: [] });
  });

  it("keeps follow-ups on the PR but out of the author's feedback", () => {
    const body = withFollowups("Add a test for the empty case.", ["handle unicode names too"]);
    const reviews = [review(7, { decision: "request-changes" })].map((r) => ({
      ...r,
      body: formatReview({ reviewer: "codex", pr: 62, head, timestamp: "2026-09-09T12:00:00Z", decision: "request-changes" }, body),
    }));
    expect(latestChangeRequestNotes(reviews, 62, head)).toBe("Add a test for the empty case.");
    expect(reviewNotes(reviews[0])).toContain("handle unicode names too"); // still on the record for triage and humans
  });
});

describe("premium different-family approval policy", () => {
  const gate = (records: ReturnType<typeof review>[], author = "codex", policy: "cross" | "cross-or-self" = "cross", authorFamily?: string) => {
    const state = reviewState(records, 62, head);
    return evaluateGate({ ...state, author, authorFamily, reviewPolicy: policy, agents: ["claude", "codex", "opencode"],
      requireCrossReview: true, checksPass: true, checksDetail: "", requireHumanMerge: false, humanApproved: false });
  };
  it.each(["free", "cheap"] as const)("never accepts %s approvals, even marked self reviews", (tier) => {
    const records = [review(1, { tier, family: "anthropic" })];
    expect(acceptedReviewers(reviewState(records, 62, head), "codex", "cross")).toEqual([]);
    expect(gate(records)).not.toEqual([]);
    const self = [review(1, { tier, family: "anthropic", mode: "self" })];
    expect(acceptedReviewers(reviewState(self, 62, head), "claude", "cross-or-self")).toEqual([]);
    expect(gate(self, "claude", "cross-or-self")).not.toEqual([]);
  });
  it.each(["standard", "lead"] as const)("accepts %s cross-family and opt-in marked self approvals", (tier) => {
    const records = [review(1, { tier, family: "anthropic" })];
    expect(gate(records)).toEqual([]);
    const self = [review(1, { tier, family: "anthropic", mode: "self" })];
    expect(gate(self, "claude", "cross-or-self")).toEqual([]);
    expect(gate(self, "claude")).not.toEqual([]);
  });
  it("rejects another harness using the author's family", () => {
    const records = [review(1, { reviewer: "opencode", tier: "lead", family: "anthropic" })];
    expect(acceptedReviewers(reviewState(records, 62, head), "claude", "cross")).toEqual([]);
    expect(gate(records, "claude")).not.toEqual([]);
    expect(gate([review(1, { tier: "standard", family: "openai" })], "opencode", "cross", "openai")).not.toEqual([]);
  });
  it("keeps legacy reviews premium with the harness default family", () => {
    expect(gate([review()])).toEqual([]);
    expect(gate([review()], "claude")).not.toEqual([]);
    expect(gate([review(1, { mode: "self" })], "claude", "cross-or-self")).toEqual([]);
  });
  it("uses metadata from the latest approval on the current head", () => {
    const records = [review(1, { tier: "lead", family: "anthropic" }), review(2, { tier: "free", family: "anthropic" })];
    expect(gate(records)).not.toEqual([]);
    expect(gate([...records, review(3, { tier: "standard", family: "anthropic" })])).toEqual([]);
  });
  it("rejects malformed tier/family fields", () => {
    for (const data of [{ tier: "bogus" }, { tier: null }, { family: 7 }, { family: " " }, { family: null }]) {
      expect(parseReview(review(1, data as never))).toBeNull();
    }
  });
});
