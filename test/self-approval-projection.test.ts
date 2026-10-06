import { describe, expect, it } from "vitest";
import { acceptedReviewers, formatReview, type ReviewRecord } from "../src/board/approval.js";
import { assemble } from "../src/board/snapshot.js";
import type { Issue, Pr } from "../src/github/github.js";
import { REVIEW_NEEDED, STATUS } from "../src/github/labels.js";
import { planRepairs, type RepairObservation } from "../src/tasks/reconcile.js";

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);

function review(over: Partial<ReviewRecord> & { id?: number }) {
  const { id = 1, ...rest } = over;
  const record: ReviewRecord = { reviewer: "claude", pr: 62, head: HEAD, timestamp: "2026-10-06T12:00:00Z", decision: "approve", ...rest };
  return { id, state: "COMMENTED", commit_id: record.head, body: formatReview(record, "reviewed") };
}
const selfApproval = (head = HEAD) => review({ reviewer: "claude", mode: "self", head });
const crossApproval = () => review({ reviewer: "codex" });
const unmarkedAuthorApproval = () => review({ reviewer: "claude" });

describe("acceptedReviewers: who counts as approved", () => {
  const state = (reviewers: string[], selfReviewers: string[] = []) => ({ reviewers, selfReviewers });

  it("always counts another harness", () => {
    for (const policy of [undefined, "cross", "cross-or-self"] as const) {
      expect(acceptedReviewers(state(["codex"]), "claude", policy)).toEqual(["codex"]);
    }
  });

  it("counts the author only as a MARKED self-review under cross-or-self", () => {
    expect(acceptedReviewers(state(["claude"], ["claude"]), "claude", "cross-or-self")).toEqual(["claude"]);
    expect(acceptedReviewers(state(["claude"], ["claude"]), "claude", "cross")).toEqual([]);
    expect(acceptedReviewers(state(["claude"], ["claude"]), "claude", undefined)).toEqual([]); // strict by default
    expect(acceptedReviewers(state(["claude"], []), "claude", "cross-or-self")).toEqual([]); // unmarked never counts
  });

  it("keeps both when a cross and a self approval coexist", () => {
    expect(acceptedReviewers(state(["claude", "codex"], ["claude"]), "claude", "cross-or-self")).toEqual(["claude", "codex"]);
    expect(acceptedReviewers(state(["claude", "codex"], ["claude"]), "claude", "cross")).toEqual(["codex"]);
  });

  it("does not count someone else's self mark as the author's", () => {
    expect(acceptedReviewers(state(["codex"], ["codex"]), "claude", "cross")).toEqual(["codex"]); // a different harness: cross
    expect(acceptedReviewers(state(["claude"], ["codex"]), "claude", "cross-or-self")).toEqual([]);
  });

  it("copes with an unknown author", () => {
    expect(acceptedReviewers(state(["codex"]), null, "cross-or-self")).toEqual(["codex"]);
  });
});

describe("repair's label projection counts a valid self-approval (it used to strip it)", () => {
  const issue = (labels: string[]): Issue => ({
    number: 36, title: "Self approved", body: "", state: "OPEN", labels: [STATUS.inReview, "agent:claude", ...labels], assignees: [],
  });
  const pr: Pr = { number: 62, title: "t", body: "Closes #36", state: "OPEN", headSha: HEAD, headRefName: "task/36-self-approved", htmlUrl: "" };
  const observe = (labels: string[], reviews: ReturnType<typeof review>[], reviewPolicy?: "cross" | "cross-or-self"): RepairObservation => ({
    number: 36, issue: issue(labels), expectedBranch: "task/36-self-approved", lockOwner: "owner",
    worktree: { kind: "usable", path: "/wt/issue-36", branch: "task/36-self-approved", removable: false },
    branch: "ahead", prs: [pr], reviews, telemetry: "submitted", ...(reviewPolicy ? { reviewPolicy } : {}),
  });
  const labelActions = (o: RepairObservation) => planRepairs(o).actions.filter((a) => a.kind === "sync-labels");

  it("leaves a current self-approval's projection alone under cross-or-self", () => {
    expect(labelActions(observe(["reviewed-by:claude"], [selfApproval()], "cross-or-self"))).toEqual([]);
  });

  it("projects it from the record when the label is missing, and does not re-queue the PR", () => {
    expect(labelActions(observe([], [selfApproval()], "cross-or-self"))).toEqual([
      { kind: "sync-labels", issue: 36, add: ["reviewed-by:claude"], remove: [] },
    ]);
  });

  it("clears a self-approval that the policy no longer accepts and asks for a real review", () => {
    for (const policy of ["cross", undefined] as const) {
      expect(labelActions(observe(["reviewed-by:claude"], [selfApproval()], policy))).toEqual([
        { kind: "sync-labels", issue: 36, add: [REVIEW_NEEDED], remove: ["reviewed-by:claude"] },
      ]);
    }
  });

  it("never accepts an unmarked author approval, whatever the policy", () => {
    expect(labelActions(observe(["reviewed-by:claude"], [unmarkedAuthorApproval()], "cross-or-self"))).toEqual([
      { kind: "sync-labels", issue: 36, add: [REVIEW_NEEDED], remove: ["reviewed-by:claude"] },
    ]);
  });

  it("does not accept a self-approval of an older head", () => {
    expect(labelActions(observe(["reviewed-by:claude"], [selfApproval(OLD)], "cross-or-self"))).toEqual([
      { kind: "sync-labels", issue: 36, add: [REVIEW_NEEDED], remove: ["reviewed-by:claude"] },
    ]);
  });

  it("is unchanged for ordinary cross-review", () => {
    expect(labelActions(observe(["reviewed-by:codex"], [crossApproval()], "cross-or-self"))).toEqual([]);
  });
});

describe("the board shows a valid self-approval's reviewer", () => {
  const issue: Issue = { number: 36, title: "t", body: "", state: "OPEN", labels: [STATUS.inReview, "agent:claude"], assignees: [] };
  const pr: Pr = { number: 62, title: "t", body: "Closes #36", state: "OPEN", headSha: HEAD, headRefName: "task/36-t", htmlUrl: "" };
  const reviewedBy = (reviews: ReturnType<typeof review>[], policy?: "cross" | "cross-or-self") =>
    assemble([issue], [pr], [36], [], [], "now", null, new Map(), new Map(), new Map([[62, reviews]]), policy).tasks[0].reviewedBy;

  it("lists the author's marked self-review under cross-or-self only", () => {
    expect(reviewedBy([selfApproval()], "cross-or-self")).toEqual(["claude"]);
    expect(reviewedBy([selfApproval()], "cross")).toEqual([]);
    expect(reviewedBy([selfApproval()])).toEqual([]);
  });

  it("never lists an unmarked author approval and still lists cross reviewers", () => {
    expect(reviewedBy([unmarkedAuthorApproval()], "cross-or-self")).toEqual([]);
    expect(reviewedBy([crossApproval()], "cross-or-self")).toEqual(["codex"]);
  });
});
