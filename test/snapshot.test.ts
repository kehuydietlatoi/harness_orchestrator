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
    htmlUrl: `https://github.com/acme/orch/pull/${number}`,
    headSha: `sha-${number}`,
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
      { issue: 12, tokensTotal: 100, costUsd: 0.01, ts: "2026-08-20T10:00:00.000Z", model: "opus" },
      { issue: 13, tokensTotal: null, costUsd: null, ts: "2026-08-21T10:00:00.000Z", model: null },
      { issue: 12, tokensTotal: 250, costUsd: 0.02, ts: "2026-08-22T10:00:00.000Z", model: "sonnet" },
    ];

    expect(
      assemble(
        issues,
        prs,
        [12, 42],
        worktrees,
        runs,
        "2026-08-23T12:00:00.000Z",
        "https://github.com/acme/orch",
        new Map([[101, "pass"]]),
        new Map([[12, { state: "ahead" }]]),
      ),
    ).toEqual({
      generatedAt: "2026-08-23T12:00:00.000Z",
      repoUrl: "https://github.com/acme/orch",
      tasks: [
        {
          number: 12,
          title: "Snapshot projection",
          status: STATUS.inReview,
          health: { kind: "in-review" },
          recoveryCommand: null,
          issueState: "OPEN",
          blockers: [],
          agent: "codex",
          deps: [10, 11],
          after: [],
          prNumber: 101,
          prUrl: "https://github.com/acme/orch/pull/101",
          prChecks: "pass",
          reviewedBy: [],
          locked: true,
          worktree: "C:\\repo\\wt\\issue-12",
          latestRun: {
            tokensTotal: 250,
            costUsd: 0.02,
            ts: "2026-08-22T10:00:00.000Z",
            model: "sonnet",
          },
        },
        {
          number: 13,
          title: "Unclaimed task",
          status: "status:inconsistent",
          health: {
            kind: "inconsistent",
            recovery: "reconcile-facts",
            violations: [
              { invariant: "worktree-requires-branch", detail: "a task worktree cannot exist without its branch" },
              { invariant: "worktree-requires-lock", detail: "a task worktree must be protected by its claim lock" },
              { invariant: "open-pr-requires-lock", detail: "an open task PR must retain the claim lock until merge" },
              { invariant: "open-pr-requires-ahead-branch", detail: "an open task PR requires submitted commits" },
              { invariant: "unrecognized-fact-combination", detail: "task worktree is detached" },
            ],
          },
          recoveryCommand: "orch repair 13",
          issueState: "OPEN",
          blockers: [],
          agent: null,
          deps: [10],
          after: [],
          prNumber: 102,
          prUrl: "https://github.com/acme/orch/pull/102",
          prChecks: null,
          reviewedBy: [],
          locked: false,
          worktree: "C:\\repo\\wt\\issue-13",
          latestRun: {
            tokensTotal: null,
            costUsd: null,
            ts: "2026-08-21T10:00:00.000Z",
            model: null,
          },
        },
        {
          number: 42,
          title: "Missing or inaccessible issue",
          status: "status:inconsistent",
          health: { kind: "inconsistent", recovery: "reconcile-facts", violations: [
            { invariant: "issue-must-exist", detail: "lifecycle facts must map to an observable GitHub issue" },
          ] },
          recoveryCommand: "orch repair 42",
          issueState: "MISSING",
          blockers: [],
          agent: null,
          deps: [],
          after: [],
          prNumber: null,
          prUrl: null,
          prChecks: null,
          reviewedBy: [],
          locked: true,
          worktree: null,
          latestRun: null,
        },
      ],
      reviewQueue: [101],
      cycles: [],
    });
  });
});
