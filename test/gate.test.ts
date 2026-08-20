import { describe, it, expect } from "vitest";
import { evaluateGate, prIssueNumber } from "../src/review.js";

const base = {
  agents: ["claude", "codex"],
  requireCrossReview: true,
  checksPass: true,
  checksDetail: "ok",
  requireHumanMerge: false,
  humanApproved: false,
};

describe("merge gate policy", () => {
  it("blocks a PR with no cross-review", () => {
    const reasons = evaluateGate({ ...base, author: "claude", reviewers: [] });
    expect(reasons.some((r) => /other harness/.test(r))).toBe(true);
  });

  it("blocks self-approval (only the author reviewed)", () => {
    const reasons = evaluateGate({ ...base, author: "claude", reviewers: ["claude"] });
    expect(reasons.some((r) => /other harness/.test(r))).toBe(true);
  });

  it("allows a PR approved by the OTHER harness with green CI", () => {
    const reasons = evaluateGate({ ...base, author: "claude", reviewers: ["codex"] });
    expect(reasons).toHaveLength(0);
  });

  it("blocks when CI is not green even with cross-review", () => {
    const reasons = evaluateGate({
      ...base,
      author: "claude",
      reviewers: ["codex"],
      checksPass: false,
      checksDetail: "1 failing",
    });
    expect(reasons.some((r) => /CI not green/.test(r))).toBe(true);
  });

  it("requires human sign-off when requireHumanMerge is on", () => {
    const on = { ...base, requireHumanMerge: true, author: "claude", reviewers: ["codex"] };
    expect(evaluateGate({ ...on, humanApproved: false }).some((r) => /requireHumanMerge/.test(r))).toBe(true);
    expect(evaluateGate({ ...on, humanApproved: true })).toHaveLength(0);
  });
});

describe("prIssueNumber mapping", () => {
  it("reads the issue from a task/<n>- branch", () => {
    expect(prIssueNumber({ headRefName: "task/42-add-thing", body: "" })).toBe(42);
  });
  it("falls back to a Closes #n line in the body", () => {
    expect(prIssueNumber({ headRefName: "feature/x", body: "Closes #7\n" })).toBe(7);
  });
  it("returns null when unmappable", () => {
    expect(prIssueNumber({ headRefName: "random", body: "no ref" })).toBeNull();
  });
});
