import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { Issue } from "../src/github/github.js";
import { STATUS, agentLabel } from "../src/github/labels.js";
import {
  claimSpecific,
  type ClaimSagaDeps,
} from "../src/tasks/service.js";
import type { Worktree, WorktreeObservation } from "../src/git/worktree.js";

type Fault = "before" | "after" | "partial";

interface Faults {
  acquire?: Fault;
  label?: Fault;
  worktree?: Fault;
  release?: Fault;
  initialWorktree?: WorktreeObservation;
}

interface Harness {
  deps: ClaimSagaDeps;
  state: {
    lock: string | null;
    issue: Issue;
    worktree: WorktreeObservation;
  };
}

const taskWorktree: Worktree = {
  path: "/worktrees/issue-34",
  branch: "task/34-recoverable-claim",
};

function editIssueState(issue: Issue, edit: Parameters<ClaimSagaDeps["editIssue"]>[1]): void {
  const labels = new Set(issue.labels);
  for (const label of edit.removeLabels ?? []) labels.delete(label);
  for (const label of edit.addLabels ?? []) labels.add(label);
  issue.labels = [...labels];

  const assignees = new Set(issue.assignees);
  for (const assignee of edit.removeAssignees ?? []) {
    assignees.delete(assignee === "@me" ? "octocat" : assignee);
  }
  for (const assignee of edit.addAssignees ?? []) {
    assignees.add(assignee === "@me" ? "octocat" : assignee);
  }
  issue.assignees = [...assignees];
}

function harness(faults: Faults = {}): Harness {
  const state: Harness["state"] = {
    lock: null,
    issue: {
      number: 34,
      title: "Recoverable claim",
      body: "",
      state: "OPEN",
      labels: [STATUS.todo, agentLabel("codex")],
      assignees: [],
    },
    worktree: faults.initialWorktree ?? { outcome: "absent" },
  };
  let labelWrites = 0;

  const deps: ClaimSagaDeps = {
    createOwnerToken: vi.fn(async () => "owner-a"),
    observeLock: vi.fn(async () => state.lock),
    acquireLock: vi.fn(async (_number, owner) => {
      if (faults.acquire === "before") throw new Error("lock write failed");
      state.lock = owner;
      if (faults.acquire === "after") throw new Error("lock response lost");
      return { outcome: "acquired" };
    }),
    releaseLock: vi.fn(async (_number, owner) => {
      if (state.lock !== owner) return false;
      if (faults.release === "before") throw new Error("release failed");
      state.lock = null;
      if (faults.release === "after") throw new Error("release response lost");
      return true;
    }),
    getIssue: vi.fn(async () => ({
      ...state.issue,
      labels: [...state.issue.labels],
      assignees: [...state.issue.assignees],
    })),
    currentLogin: vi.fn(async () => "octocat"),
    editIssue: vi.fn(async (_number, edit) => {
      labelWrites += 1;
      if (labelWrites === 1 && faults.label === "before") {
        throw new Error("label write failed");
      }
      if (labelWrites === 1 && faults.label === "partial") {
        state.issue.labels.push(STATUS.claimed);
        throw new Error("label response lost after a partial write");
      }
      editIssueState(state.issue, edit);
      if (labelWrites === 1 && faults.label === "after") {
        throw new Error("label response lost");
      }
    }),
    observeWorktree: vi.fn(async () => state.worktree),
    addWorktree: vi.fn(async () => {
      if (faults.worktree === "before") throw new Error("worktree write failed");
      state.worktree = { outcome: "usable", worktree: taskWorktree };
      if (faults.worktree === "after") throw new Error("worktree response lost");
      return taskWorktree;
    }),
  };
  return { deps, state };
}

async function claim(h: Harness) {
  return claimSpecific(34, "codex", DEFAULT_CONFIG, "/repo", h.deps);
}

function expectReadyProjection(h: Harness): void {
  expect(h.state.lock).toBeNull();
  expect(h.state.issue.labels).toContain(STATUS.todo);
  expect(h.state.issue.labels).not.toContain(STATUS.claimed);
  expect(h.state.issue.labels).toContain(agentLabel("codex"));
  expect(h.state.issue.assignees).not.toContain("octocat");
}

beforeEach(() => vi.restoreAllMocks());

describe("recoverable claim setup saga", () => {
  it("does not mutate when initial observation finds an unowned worktree", async () => {
    const h = harness({
      initialWorktree: { outcome: "usable", worktree: taskWorktree },
    });

    await expect(claim(h)).rejects.toThrow(/unowned task worktree/i);

    expect(h.deps.acquireLock).not.toHaveBeenCalled();
    expect(h.deps.editIssue).not.toHaveBeenCalled();
    expect(h.deps.addWorktree).not.toHaveBeenCalled();
  });

  it("does not compensate a lock write that never established ownership", async () => {
    const h = harness({ acquire: "before" });

    await expect(claim(h)).rejects.toThrow(/lock write failed/i);

    expect(h.deps.editIssue).not.toHaveBeenCalled();
    expect(h.deps.releaseLock).not.toHaveBeenCalled();
    expectReadyProjection(h);
  });

  it("does not compensate an ambiguous lock now owned by another attempt", async () => {
    const h = harness();
    vi.mocked(h.deps.acquireLock).mockImplementationOnce(async () => {
      h.state.lock = "owner-b";
      return { outcome: "error", detail: "ambiguous lock response" };
    });

    await expect(claim(h)).rejects.toThrow(/another agent/i);

    expect(h.state.lock).toBe("owner-b");
    expect(h.deps.editIssue).not.toHaveBeenCalled();
    expect(h.deps.releaseLock).not.toHaveBeenCalled();
  });

  it("compensates when the GitHub projection write fails", async () => {
    const h = harness({ label: "before" });

    await expect(claim(h)).rejects.toThrow(/label write failed/i);

    expect(h.deps.addWorktree).not.toHaveBeenCalled();
    expect(h.deps.releaseLock).toHaveBeenCalledWith(34, "owner-a", "/repo");
    expectReadyProjection(h);
  });

  it("cleans a partial claimed label before releasing ownership", async () => {
    const h = harness({ label: "partial" });

    await expect(claim(h)).rejects.toThrow(/partial write/i);

    expect(h.deps.editIssue).toHaveBeenCalledTimes(2);
    expectReadyProjection(h);
  });

  it("compensates GitHub and the owned lock when worktree creation fails", async () => {
    const h = harness({ worktree: "before" });

    await expect(claim(h)).rejects.toThrow(/worktree write failed/i);

    expect(h.deps.editIssue).toHaveBeenCalledTimes(2);
    expectReadyProjection(h);
  });

  it("removes an agent label introduced by a failed claim while preserving routing labels", async () => {
    const h = harness({ worktree: "before" });
    h.state.issue.labels = [STATUS.todo, "effort:hard"];

    await expect(claim(h)).rejects.toThrow(/worktree write failed/i);

    expect(h.state.issue.labels).toEqual(expect.arrayContaining([STATUS.todo, "effort:hard"]));
    expect(h.state.issue.labels).not.toContain(STATUS.claimed);
    expect(h.state.issue.labels).not.toContain(agentLabel("codex"));
  });

  it("accepts an acquired lock whose success response was lost", async () => {
    const h = harness({ acquire: "after" });

    const result = await claim(h);

    expect(result.worktree).toEqual(taskWorktree);
    expect(h.state.lock).toBe("owner-a");
    expect(h.state.issue.labels).toContain(STATUS.claimed);
  });

  it("accepts a complete GitHub projection whose success response was lost", async () => {
    const h = harness({ label: "after" });

    const result = await claim(h);

    expect(result.issue.labels).toContain(STATUS.claimed);
    expect(result.worktree).toEqual(taskWorktree);
    expect(h.deps.editIssue).toHaveBeenCalledTimes(1);
  });

  it("accepts a usable registered worktree whose success response was lost", async () => {
    const h = harness({ worktree: "after" });

    const result = await claim(h);

    expect(result.worktree).toEqual(taskWorktree);
    expect(h.state.lock).toBe("owner-a");
    expect(h.state.issue.labels).toContain(STATUS.claimed);
  });

  it("accepts a lost lock-release response after observing ownership is gone", async () => {
    const h = harness({ worktree: "before", release: "after" });

    await expect(claim(h)).rejects.toThrow(/worktree write failed/i);

    expectReadyProjection(h);
  });

  it("retries a transient GitHub compensation failure before releasing ownership", async () => {
    const h = harness({ worktree: "before" });
    vi.mocked(h.deps.editIssue).mockImplementationOnce(async (_number, edit) => {
      editIssueState(h.state.issue, edit);
    }).mockRejectedValueOnce(new Error("compensation unavailable"));

    await expect(claim(h)).rejects.toThrow(/worktree write failed/i);

    expect(h.deps.editIssue).toHaveBeenCalledTimes(3);
    expectReadyProjection(h);
  });
});
