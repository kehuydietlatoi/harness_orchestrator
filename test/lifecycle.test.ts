import { describe, expect, it } from "vitest";
import {
  TASK_STATE_KINDS,
  decideTaskTransition,
  deriveTaskState,
  projectLifecycleLabels,
  type TaskEvent,
  type TaskFacts,
  type TaskStateKind,
} from "../src/tasks/lifecycle.js";
import { NEEDS_ATTENTION, STATUS } from "../src/github/labels.js";

const ready: TaskFacts = {
  issue: "open",
  lock: false,
  worktree: false,
  branch: "absent",
  pr: "none",
  telemetry: "none",
};

describe("deriveTaskState", () => {
  it.each<[string, TaskFacts, TaskStateKind]>([
    ["ready", ready, "ready"],
    ["claimed during setup", { ...ready, lock: true }, "claimed"],
    ["claimed with an unchanged worktree", { ...ready, lock: true, worktree: true, branch: "unchanged" }, "claimed"],
    ["in progress", { ...ready, lock: true, worktree: true, branch: "ahead" }, "in-progress"],
    [
      "in review",
      { ...ready, lock: true, worktree: true, branch: "ahead", pr: "open", telemetry: "submitted" },
      "in-review",
    ],
    ["needs attention after failure", { ...ready, telemetry: "failed" }, "needs-attention"],
    ["needs attention after no commits", { ...ready, branch: "unchanged", telemetry: "no-commits" }, "needs-attention"],
    ["needs attention after a PR closes", { ...ready, branch: "ahead", pr: "closed", telemetry: "submitted" }, "needs-attention"],
    ["needs attention for orphaned work", { ...ready, branch: "ahead" }, "needs-attention"],
    ["done after merge and cleanup", { ...ready, issue: "closed", branch: "ahead", pr: "merged", telemetry: "submitted" }, "done"],
    ["done when manually closed", { ...ready, issue: "closed" }, "done"],
    ["inconsistent", { ...ready, worktree: true }, "inconsistent"],
  ])("derives %s", (_name, facts, expected) => {
    expect(deriveTaskState(facts).kind).toBe(expected);
  });

  it.each([
    ["missing issue", { ...ready, issue: "missing" }, ["issue-must-exist"]],
    ["worktree without branch or lock", { ...ready, worktree: true }, ["worktree-requires-branch", "worktree-requires-lock"]],
    ["closed issue with lock", { ...ready, issue: "closed", lock: true }, ["closed-issue-forbids-lock"]],
    ["closed issue with worktree", { ...ready, issue: "closed", worktree: true, branch: "unchanged" }, ["worktree-requires-lock", "closed-issue-forbids-worktree"]],
    ["open PR on a closed issue", { ...ready, issue: "closed", pr: "open" }, ["open-pr-requires-open-issue", "open-pr-requires-lock", "open-pr-requires-worktree", "open-pr-requires-ahead-branch"]],
    ["open PR without claim resources", { ...ready, branch: "ahead", pr: "open" }, ["open-pr-requires-lock", "open-pr-requires-worktree"]],
    ["open PR without commits", { ...ready, lock: true, worktree: true, branch: "unchanged", pr: "open" }, ["open-pr-requires-ahead-branch"]],
    ["merged PR on an open issue", { ...ready, branch: "ahead", pr: "merged", telemetry: "submitted" }, ["merged-pr-requires-closed-issue"]],
    ["submitted telemetry without a PR", { ...ready, telemetry: "submitted" }, ["submitted-run-requires-pr"]],
    ["failed telemetry with an open PR", { ...ready, lock: true, worktree: true, branch: "ahead", pr: "open", telemetry: "failed" }, ["failed-run-forbids-open-pr", "finished-run-requires-released-resources"]],
    ["failed telemetry retaining resources", { ...ready, lock: true, worktree: true, branch: "unchanged", telemetry: "no-commits" }, ["finished-run-requires-released-resources"]],
  ] satisfies Array<[string, TaskFacts, string[]]>)("marks %s inconsistent", (_name, facts, invariants) => {
    const state = deriveTaskState(facts);
    expect(state.kind).toBe("inconsistent");
    if (state.kind === "inconsistent") {
      expect(state.violations.map((item) => item.invariant)).toEqual(invariants);
      expect(state.recovery).toBe("reconcile-facts");
    }
  });

  it("classifies every finite fact combination without I/O or exceptions", () => {
    const issues = ["open", "closed", "missing"] as const;
    const booleans = [false, true] as const;
    const branches = ["absent", "unchanged", "ahead"] as const;
    const prs = ["none", "open", "closed", "merged"] as const;
    const telemetry = ["none", "submitted", "failed", "no-commits"] as const;
    const seen = new Set<TaskStateKind>();

    for (const issue of issues)
      for (const lock of booleans)
        for (const worktree of booleans)
          for (const branch of branches)
            for (const pr of prs)
              for (const run of telemetry) {
                const state = deriveTaskState({ issue, lock, worktree, branch, pr, telemetry: run });
                expect(TASK_STATE_KINDS).toContain(state.kind);
                seen.add(state.kind);
              }

    expect([...seen].sort()).toEqual([...TASK_STATE_KINDS].sort());
  });
});

describe("decideTaskTransition", () => {
  const legal = [
    ["ready", "claim", "claimed"],
    ["claimed", "start-work", "in-progress"],
    ["claimed", "reset", "ready"],
    ["in-progress", "submit", "in-review"],
    ["in-progress", "run-failed", "needs-attention"],
    ["in-progress", "reset", "ready"],
    ["in-review", "request-changes", "in-progress"],
    ["in-review", "merge", "done"],
    ["in-review", "reset", "ready"],
    ["needs-attention", "reset", "ready"],
  ] as const satisfies ReadonlyArray<readonly [TaskStateKind, TaskEvent, TaskStateKind]>;

  it.each(legal)("allows %s --%s--> %s", (from, event, to) => {
    expect(decideTaskTransition(from, event)).toEqual({ allowed: true, from, event, to });
  });

  it("rejects every state/event pair outside the legal transition table", () => {
    const events: TaskEvent[] = ["claim", "start-work", "submit", "request-changes", "run-failed", "merge", "reset"];
    const allowed = new Set(legal.map(([from, event]) => `${from}:${event}`));

    for (const from of TASK_STATE_KINDS) {
      for (const event of events) {
        if (allowed.has(`${from}:${event}`)) continue;
        expect(decideTaskTransition(from, event)).toMatchObject({ allowed: false, from, event });
      }
    }
  });
});

describe("projectLifecycleLabels", () => {
  it.each([
    ["ready", [STATUS.todo]],
    ["claimed", [STATUS.claimed]],
    ["in-progress", [STATUS.inProgress]],
    ["in-review", [STATUS.inReview]],
    ["needs-attention", [NEEDS_ATTENTION]],
    ["done", [STATUS.done]],
    ["inconsistent", [NEEDS_ATTENTION]],
  ] as const)("projects %s without reading labels", (state, labels) => {
    expect(projectLifecycleLabels(state)).toEqual(labels);
  });
});
