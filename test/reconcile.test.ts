import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { Issue, Pr } from "../src/github/github.js";
import { NEEDS_ATTENTION, REVIEW_NEEDED, STATUS } from "../src/github/labels.js";
import {
  planRepairs,
  reconcileIssue,
  type ReconcileDeps,
  type RepairAction,
  type RepairObservation,
} from "../src/tasks/reconcile.js";

function issue(over: Partial<Issue> = {}): Issue {
  return {
    number: 36,
    title: "Preview-first repair",
    body: "",
    state: "OPEN",
    labels: [STATUS.todo],
    assignees: [],
    ...over,
  };
}

function pr(state: Pr["state"] = "OPEN"): Pr {
  return {
    number: 136,
    title: "Repair",
    body: "Closes #36",
    headRefName: "task/36-preview-first-repair",
    state,
    htmlUrl: "https://github.com/acme/orch/pull/136",
    headSha: "sha-136",
  };
}

function observation(over: Partial<RepairObservation> = {}): RepairObservation {
  return {
    number: 36,
    issue: issue(),
    expectedBranch: "task/36-preview-first-repair",
    lockOwner: null,
    worktree: { kind: "absent" },
    branch: "absent",
    prs: [],
    telemetry: "none",
    ...over,
  };
}

function fakeDeps(initial: RepairObservation): {
  deps: ReconcileDeps;
  current: () => RepairObservation;
  executed: RepairAction[];
  apply: ReconcileDeps["execute"];
} {
  const current = structuredClone(initial);
  const executed: RepairAction[] = [];
  const apply: ReconcileDeps["execute"] = async (action) => {
    executed.push(action);
    switch (action.kind) {
      case "prune-worktree-registration":
        current.worktree = { kind: "absent" };
        break;
      case "restore-branch":
        current.branch = "ahead";
        break;
      case "acquire-lock":
        current.lockOwner = "repair-owner";
        break;
      case "add-worktree":
        current.worktree = {
          kind: "usable",
          path: "/wt/issue-36",
          branch: current.expectedBranch ?? "task/36-preview-first-repair",
          removable: false,
          retentionReason: "HEAD is not preserved elsewhere",
        };
        if (current.branch === "absent") current.branch = "unchanged";
        break;
      case "safe-remove-worktree":
        current.worktree = { kind: "absent" };
        break;
      case "release-lock":
        current.lockOwner = null;
        break;
      case "close-issue":
        if (current.issue) current.issue.state = "CLOSED";
        break;
      case "supersede-telemetry":
        current.telemetry = "none";
        break;
      case "sync-labels": {
        if (!current.issue) break;
        const labels = new Set(current.issue.labels);
        for (const label of action.remove) labels.delete(label);
        for (const label of action.add) labels.add(label);
        current.issue.labels = [...labels];
        break;
      }
    }
  };
  const deps: ReconcileDeps = {
    observe: vi.fn(async () => structuredClone(current)),
    execute: vi.fn(apply),
  };
  return { deps, current: () => structuredClone(current), executed, apply };
}

describe("planRepairs", () => {
  it("projects stale labels from lifecycle facts without mutating the observation", () => {
    const observed = observation({ issue: issue({ labels: [STATUS.claimed, NEEDS_ATTENTION] }) });

    const plan = planRepairs(observed);

    expect(plan.state.kind).toBe("ready");
    expect(plan.actions).toEqual([
      {
        kind: "sync-labels",
        issue: 36,
        add: [STATUS.todo],
        remove: [NEEDS_ATTENTION, STATUS.claimed],
      },
    ]);
    expect(observed.issue?.labels).toEqual([STATUS.claimed, NEEDS_ATTENTION]);
  });

  it("rebuilds an open PR's branch, lock, worktree, and GitHub projection", () => {
    const plan = planRepairs(
      observation({
        issue: issue({ labels: [STATUS.todo] }),
        prs: [pr()],
        telemetry: "submitted",
      }),
    );

    expect(plan.actions.map((action) => action.kind)).toEqual([
      "restore-branch",
      "acquire-lock",
      "add-worktree",
      "sync-labels",
    ]);
    expect(plan.projectedState.kind).toBe("in-review");
    expect(plan.actions.at(-1)).toMatchObject({
      add: [REVIEW_NEEDED, STATUS.inReview],
      remove: [STATUS.todo],
    });
  });

  it("safely cleans terminal residue before releasing its lock", () => {
    const plan = planRepairs(
      observation({
        issue: issue({ state: "CLOSED", labels: [STATUS.inReview] }),
        lockOwner: "owner",
        worktree: {
          kind: "usable",
          path: "/wt/issue-36",
          branch: "task/36-preview-first-repair",
          removable: true,
        },
        branch: "ahead",
        prs: [pr("MERGED")],
        telemetry: "submitted",
      }),
    );

    expect(plan.actions.map((action) => action.kind)).toEqual([
      "safe-remove-worktree",
      "release-lock",
      "sync-labels",
    ]);
    expect(plan.projectedState.kind).toBe("done");
  });

  it("restores a missing lock before preserving uncommitted work", () => {
    const plan = planRepairs(
      observation({
        issue: issue({ labels: [STATUS.inProgress] }),
        worktree: {
          kind: "usable",
          path: "/wt/issue-36",
          branch: "task/36-preview-first-repair",
          removable: false,
          retentionReason: "worktree has dirty, untracked, or ignored files",
        },
        branch: "unchanged",
        telemetry: "failed",
      }),
    );

    expect(plan.actions.map((action) => action.kind)).toContain("acquire-lock");
    expect(plan.actions.map((action) => action.kind)).not.toContain("safe-remove-worktree");
    expect(plan.actions.map((action) => action.kind)).not.toContain("supersede-telemetry");
  });

  it("removes stale review-needed after an approval projection is present", () => {
    const plan = planRepairs(
      observation({
        issue: issue({ labels: [STATUS.inReview, REVIEW_NEEDED, "reviewed-by:codex"] }),
        lockOwner: "owner",
        worktree: {
          kind: "usable",
          path: "/wt/issue-36",
          branch: "task/36-preview-first-repair",
          removable: false,
        },
        branch: "ahead",
        prs: [pr()],
        telemetry: "submitted",
      }),
    );

    expect(plan.actions).toEqual([
      { kind: "sync-labels", issue: 36, add: [], remove: [REVIEW_NEEDED] },
    ]);
  });

  it.each([
    ["dirty or untracked", { kind: "usable", path: "/wt/issue-36", branch: "task/36-preview-first-repair", removable: false, retentionReason: "worktree has dirty, untracked, or ignored files" }],
    ["detached", { kind: "conflict", path: "/wt/issue-36", detail: "path is attached to 'detached HEAD'" }],
  ] as const)("preserves %s work instead of proposing destructive cleanup", (_name, worktree) => {
    const plan = planRepairs(
      observation({
        issue: issue({ labels: [STATUS.inProgress] }),
        lockOwner: "owner",
        worktree,
        branch: "unchanged",
        telemetry: "failed",
      }),
    );

    expect(plan.actions.map((action) => action.kind)).not.toContain("safe-remove-worktree");
    expect(plan.actions.map((action) => action.kind)).not.toContain("release-lock");
    expect(plan.actions.map((action) => action.kind)).not.toContain("supersede-telemetry");
    expect(plan.blocked.join(" ")).toMatch(/preserved/i);
  });
});

describe("reconcileIssue", () => {
  it("is read-only by default", async () => {
    const harness = fakeDeps(observation({ issue: issue({ labels: [STATUS.claimed] }) }));

    const result = await reconcileIssue(36, DEFAULT_CONFIG, "/repo", {}, harness.deps);

    expect(result.actions).toHaveLength(1);
    expect(result.applied).toEqual([]);
    expect(harness.deps.execute).not.toHaveBeenCalled();
  });

  it("re-observes after every action and converges to no actions", async () => {
    const harness = fakeDeps(
      observation({
        issue: issue({ labels: [STATUS.todo] }),
        prs: [pr()],
        telemetry: "submitted",
      }),
    );

    const first = await reconcileIssue(36, DEFAULT_CONFIG, "/repo", { apply: true }, harness.deps);
    const second = await reconcileIssue(36, DEFAULT_CONFIG, "/repo", { apply: true }, harness.deps);

    expect(first.applied.map((action) => action.kind)).toEqual([
      "restore-branch",
      "acquire-lock",
      "add-worktree",
      "sync-labels",
    ]);
    expect(first.actions).toEqual([]);
    expect(second.actions).toEqual([]);
    expect(second.applied).toEqual([]);
    expect(harness.current().issue?.labels).toEqual(
      expect.arrayContaining([STATUS.inReview, REVIEW_NEEDED]),
    );
  });

  it("resumes from durable observations after an interrupted ambiguous write", async () => {
    const harness = fakeDeps(
      observation({
        issue: issue({ labels: [STATUS.todo] }),
        branch: "ahead",
        prs: [pr()],
        telemetry: "submitted",
      }),
    );
    const execute = harness.deps.execute;
    vi.mocked(execute).mockImplementationOnce(async (action, observed, cfg, cwd) => {
      await harness.apply(action, observed, cfg, cwd);
      throw new Error("lock response lost");
    });

    await expect(
      reconcileIssue(36, DEFAULT_CONFIG, "/repo", { apply: true }, harness.deps),
    ).rejects.toThrow("lock response lost");
    expect(harness.current().lockOwner).toBe("repair-owner");

    const resumed = await reconcileIssue(36, DEFAULT_CONFIG, "/repo", { apply: true }, harness.deps);

    expect(resumed.applied.map((action) => action.kind)).toEqual(["add-worktree", "sync-labels"]);
    expect(resumed.actions).toEqual([]);
  });
});
