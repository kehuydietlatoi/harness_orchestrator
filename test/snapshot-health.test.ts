import { describe, expect, it } from "vitest";
import { assemble, type BranchObservation, type SnapshotRun } from "../src/board/snapshot.js";
import { formatSnapshotTable } from "../src/commands/snapshot.js";
import { formatStatusTask } from "../src/commands/status.js";
import { lifecycleChecks } from "../src/commands/doctor.js";
import type { Issue, Pr } from "../src/github/github.js";
const issue: Issue = { number: 1, title: "task", state: "OPEN", body: "", labels: ["status:todo"], assignees: [] };
const pr: Pr = { number: 2, title: "pr", state: "CLOSED", headRefName: "task/1-x", body: "", headSha: "a", htmlUrl: "" };
const run = (outcome: string): SnapshotRun => ({ issue: 1, outcome, ts: "2026-09-09", model: null, tokensTotal: null, costUsd: null });
describe("lifecycle health projection", () => {
  it.each([
    ["ready", [], [], [], [], "absent"],
    ["claimed", [1], [], [], [], "absent"],
    ["in-progress", [1], [{ path: "/wt/issue-1", branch: "task/1-x" }], [], [], "ahead"],
    ["in-review", [1], [{ path: "/wt/issue-1", branch: "task/1-x" }], [{ ...pr, state: "OPEN" }], [], "ahead"],
    ["needs-attention", [], [], [pr], [], "unchanged"],
    ["needs-attention", [], [], [], [run("failed")], "absent"],
    ["ready", [], [], [], [run("failed"), run("repaired")], "absent"],
    ["inconsistent", [], [{ path: "/wt/issue-1", branch: "task/1-x" }], [], [], "unchanged"],
    ["inconsistent", [1], [{ path: "/wt/issue-1", branch: "task/1-x" }], [], [], "absent"],
  ] as const)("shows %s from facts across consumers", (kind, locks, trees, prs, runs, branch) => {
    const snapshot = assemble([issue], prs, locks, trees, runs, "now", null, new Map(), new Map([[1, { state: branch }]]));
    const task = snapshot.tasks[0];
    expect(task.health.kind).toBe(kind);
    expect(formatSnapshotTable(snapshot)).toContain(kind);
    expect(formatStatusTask(task)).toContain(`[${kind}]`);
    expect(lifecycleChecks(snapshot)[0].name).toContain(kind);
    if (["inconsistent", "needs-attention"].includes(kind)) {
      expect(task.recoveryCommand).toBe("orch repair 1");
      expect(lifecycleChecks(snapshot)[0].ok).toBe(false);
    }
  });
  it("includes closed-issue residue and missing-issue locks but excludes cleaned closed issues", () => {
    const snapshot = assemble([{ ...issue, state: "CLOSED" }, { ...issue, number: 3, state: "CLOSED" }], [], [1, 2], [], []);
    expect(snapshot.tasks.map((t) => t.number)).toEqual([1, 2]);
    expect(snapshot.tasks.every((t) => t.health.kind === "inconsistent" && t.recoveryCommand)).toBe(true);
  });
  it("surfaces observation errors, detached worktrees, and wrong branches", () => {
    const branch: BranchObservation = { state: "unchanged", error: "git comparison failed" };
    for (const treeBranch of ["", "other"]) {
      const snapshot = assemble([issue], [], [1], [{ path: "/wt/issue-1", branch: treeBranch }], [], "now", null, new Map(), new Map([[1, branch]]));
      expect(snapshot.tasks[0].health.kind).toBe("inconsistent");
      expect(formatSnapshotTable(snapshot)).toContain("git comparison failed");
    }
  });
  it("only open dependencies block, even when closed residue is visible", () => {
    const snapshot = assemble([{ ...issue, body: "Depends-on: #2, #3" }, { ...issue, number: 2, state: "CLOSED" }, { ...issue, number: 3 }], [], [2], [], []);
    expect(snapshot.tasks[0].blockers).toEqual([3]);
  });
});
