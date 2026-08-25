import { describe, expect, it } from "vitest";
import { STATUS, REVIEW_NEEDED } from "../src/github/labels.js";
import { assemble } from "../src/board/snapshot.js";
import type { Issue, Pr } from "../src/github/github.js";
import type { SnapshotRun } from "../src/board/snapshot.js";
import type { Worktree } from "../src/git/worktree.js";

function issue(number: number, over: Partial<Issue> = {}): Issue {
  return {
    number,
    title: `Task ${number}`,
    body: "",
    state: "OPEN",
    labels: [],
    assignees: [],
    ...over,
  };
}

function pr(number: number, over: Partial<Pr> = {}): Pr {
  return {
    number,
    title: `PR ${number}`,
    body: "",
    headRefName: "",
    state: "OPEN",
    ...over,
  };
}

describe("assemble", () => {
  it("projects issues, PRs, locks, worktrees, reviews, dependencies, and latest runs", () => {
    const issues = [
      issue(13, {
        title: "Unclaimed task",
        body: "Depends on #10",
      }),
      issue(12, {
        title: "Snapshot projection",
        body: "Depends-on: #10, #11",
        labels: [STATUS.inReview, "agent:codex", REVIEW_NEEDED, "reviewed-by:claude"],
      }),
    ];
    const prs = [
      pr(102, { headRefName: "task/13-unclaimed-task" }),
      pr(101, { body: "Closes #12" }),
      pr(999, { headRefName: "unrelated" }),
    ];
    const worktrees: Worktree[] = [
      { path: "C:\\repo\\wt\\issue-12", branch: "refs/heads/task/12-snapshot-projection" },
      { path: "C:\\repo\\wt\\issue-13", branch: "" },
    ];
    const runs: SnapshotRun[] = [
      { issue: 12, tokensTotal: 100, costUsd: 0.01, ts: "2026-08-20T10:00:00.000Z" },
      { issue: 13, tokensTotal: null, costUsd: null, ts: "2026-08-21T10:00:00.000Z" },
      { issue: 12, tokensTotal: 250, costUsd: 0.02, ts: "2026-08-22T10:00:00.000Z" },
    ];

    expect(assemble(issues, prs, [12, 42], worktrees, runs, "2026-08-23T12:00:00.000Z")).toEqual({
      generatedAt: "2026-08-23T12:00:00.000Z",
      tasks: [
        {
          number: 12,
          title: "Snapshot projection",
          status: STATUS.inReview,
          agent: "codex",
          deps: [10, 11],
          prNumber: 101,
          reviewedBy: ["claude"],
          locked: true,
          worktree: "C:\\repo\\wt\\issue-12",
          latestRun: {
            tokensTotal: 250,
            costUsd: 0.02,
            ts: "2026-08-22T10:00:00.000Z",
          },
        },
        {
          number: 13,
          title: "Unclaimed task",
          status: STATUS.todo,
          agent: null,
          deps: [10],
          prNumber: 102,
          reviewedBy: [],
          locked: false,
          worktree: "C:\\repo\\wt\\issue-13",
          latestRun: {
            tokensTotal: null,
            costUsd: null,
            ts: "2026-08-21T10:00:00.000Z",
          },
        },
      ],
      reviewQueue: [101],
    });
  });
});
