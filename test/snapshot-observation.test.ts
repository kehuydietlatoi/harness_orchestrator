import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/github/github.js", () => ({ listIssues: vi.fn(), listPrs: vi.fn(), getIssue: vi.fn(), getBranchPrs: vi.fn(), getIssueReferencedPrs: vi.fn(), getRepoUrl: vi.fn(), prChecksState: vi.fn() }));
vi.mock("../src/git/lock.js", () => ({ listLocks: vi.fn() }));
vi.mock("../src/git/git.js", () => ({ resolveBaseBranch: vi.fn(), compareBranchToBase: vi.fn() }));
vi.mock("../src/config.js", () => ({ loadConfig: () => ({ baseBranch: "main" }) }));
vi.mock("../src/board/telemetry.js", () => ({ readRuns: () => [] }));
vi.mock("../src/util/exec.js", () => ({ exec: vi.fn() }));
import * as gh from "../src/github/github.js";
import * as git from "../src/git/git.js";
import { listLocks } from "../src/git/lock.js";
import { exec } from "../src/util/exec.js";
import { buildSnapshot } from "../src/board/snapshot.js";
let fixture = 0;
beforeEach(() => {
  vi.resetAllMocks(); fixture++;
  vi.mocked(gh.listIssues).mockResolvedValue([{ number: 1, state: "OPEN", labels: ["review:needed"], assignees: [], body: "", title: "task" }]);
  vi.mocked(gh.listPrs).mockResolvedValue([{ number: 2, state: "OPEN", headRefName: "task/1-x", body: "", title: "pr", headSha: "a", htmlUrl: "" }]);
  vi.mocked(gh.getRepoUrl).mockResolvedValue(null);
  vi.mocked(gh.getBranchPrs).mockResolvedValue([]);
  vi.mocked(gh.getIssueReferencedPrs).mockResolvedValue([]);
  vi.mocked(gh.prChecksState).mockResolvedValue("pending");
  vi.mocked(listLocks).mockResolvedValue([1]);
  vi.mocked(git.resolveBaseBranch).mockResolvedValue({ name: "main", ref: "refs/heads/main" });
  vi.mocked(git.compareBranchToBase).mockResolvedValue("ahead");
  vi.mocked(exec).mockImplementation(async (_cmd, args) => ({ code: 0, stderr: "", stdout:
    args?.[0] === "worktree" ? `worktree ${process.cwd()}/src\nbranch refs/heads/task/1-x\n\n` : "task/1-x\n" }));
});
describe("snapshot observation", () => {
  it("reads GitHub collections once and derives health from branch observations", async () => {
    const snapshot = await buildSnapshot(`/repo-${fixture}`);
    expect(snapshot.tasks[0].health.kind).toBe("in-review");
    expect(gh.listIssues).toHaveBeenCalledOnce();
    expect(gh.listPrs).toHaveBeenCalledOnce();
    expect(gh.listIssues).toHaveBeenCalledWith({ cwd: `/repo-${fixture}`, state: "open" });
    expect(gh.listPrs).toHaveBeenCalledWith({ cwd: `/repo-${fixture}`, state: "open" });
    expect(gh.getIssue).not.toHaveBeenCalled();
    expect(gh.getBranchPrs).not.toHaveBeenCalled();
    expect(gh.getIssueReferencedPrs).not.toHaveBeenCalled();
    expect(listLocks).toHaveBeenCalledWith({ cwd: `/repo-${fixture}`, strict: true });
  });
  it("looks up only unique retained-resource issues absent from the open set", async () => {
    const cwd = `/repo-${fixture}`;
    vi.mocked(listLocks).mockResolvedValue([1, 3, 4]);
    vi.mocked(gh.getIssue).mockImplementation(async (number) => {
      if (number === 4) throw new Error("not found");
      return { number, state: "CLOSED", title: "closed", labels: [], assignees: [], body: "" };
    });
    vi.mocked(exec).mockImplementation(async (_cmd, args) => ({ code: 0, stderr: "", stdout:
      args?.[0] === "worktree" ? `worktree ${process.cwd()}/src\nbranch refs/heads/task/3-closed\n\n` : "task/3-closed\ntask/99-old\n" }));
    const snapshot = await buildSnapshot(cwd);
    expect(vi.mocked(gh.getIssue).mock.calls).toEqual([[3, { cwd }], [4, { cwd }]]);
    expect(snapshot.tasks.map((task) => [task.number, task.issueState])).toEqual([[1, "OPEN"], [3, "CLOSED"], [4, "MISSING"]]);
    expect(snapshot.tasks.slice(1).every((task) => task.health.kind === "inconsistent")).toBe(true);
    expect(gh.getBranchPrs).toHaveBeenCalledOnce();
    expect(gh.getBranchPrs).toHaveBeenCalledWith("task/3-closed", { cwd });
    expect(gh.listIssues).toHaveBeenCalledOnce();
    expect(gh.listIssues).toHaveBeenCalledWith({ cwd, state: "open" });
    expect(gh.listPrs).toHaveBeenCalledOnce();
    expect(gh.listPrs).toHaveBeenCalledWith({ cwd, state: "open" });
  });
  it("does not compare or fetch history for old branches without an open issue, lock, or worktree", async () => {
    vi.mocked(gh.listIssues).mockResolvedValue([]);
    vi.mocked(gh.listPrs).mockResolvedValue([]);
    vi.mocked(listLocks).mockResolvedValue([]);
    vi.mocked(exec).mockImplementation(async (_cmd, args) => ({ code: 0, stderr: "", stdout:
      args?.[0] === "worktree" ? "" : Array.from({ length: 500 }, (_, i) => `task/${i + 10}-merged`).join("\n") }));
    expect((await buildSnapshot(`/repo-${fixture}`)).tasks).toEqual([]);
    expect(git.compareBranchToBase).not.toHaveBeenCalled();
    expect(gh.getIssue).not.toHaveBeenCalled();
    expect(gh.getBranchPrs).not.toHaveBeenCalled();
    expect(gh.getIssueReferencedPrs).not.toHaveBeenCalled();
  });
  it("does not fetch PR history for a plain todo without local resources", async () => {
    vi.mocked(gh.listIssues).mockResolvedValue([{ number: 1, state: "OPEN", labels: ["status:todo"], assignees: [], body: "", title: "task" }]);
    vi.mocked(gh.listPrs).mockResolvedValue([]);
    vi.mocked(listLocks).mockResolvedValue([]);
    vi.mocked(exec).mockResolvedValue({ code: 0, stderr: "", stdout: "" });
    const task = (await buildSnapshot(`/repo-${fixture}`)).tasks[0];
    expect(task.health).toEqual({ kind: "ready" });
    expect(task.prNumber).toBeNull();
    expect(gh.getBranchPrs).not.toHaveBeenCalled();
    expect(gh.getIssueReferencedPrs).not.toHaveBeenCalled();
  });
  it("caches locked-task PR history for sixty seconds and isolates repositories", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(100_000);
    try {
      const cwd = `/repo-${fixture}`;
      vi.mocked(gh.listPrs).mockImplementation(async () => []);
      vi.mocked(exec).mockResolvedValue({ code: 0, stderr: "", stdout: "" });
      expect((await buildSnapshot(cwd)).tasks[0].health).toEqual({ kind: "claimed" });
      const pr = { number: 2, state: "CLOSED", headRefName: "task/1-task", body: "", title: "pr", headSha: "a", htmlUrl: "" };
      vi.mocked(gh.getBranchPrs).mockResolvedValue([pr]);
      now.mockReturnValue(102_000);
      expect((await buildSnapshot(cwd)).tasks[0].health).toEqual({ kind: "claimed" });
      expect(gh.getBranchPrs).toHaveBeenCalledOnce();
      expect(gh.getIssueReferencedPrs).toHaveBeenCalledOnce();
      now.mockReturnValue(160_000);
      expect((await buildSnapshot(cwd)).tasks[0].prNumber).toBe(2);
      expect(gh.getBranchPrs).toHaveBeenCalledTimes(2);
      expect(gh.getIssueReferencedPrs).toHaveBeenCalledTimes(2);
      now.mockReturnValue(162_000);
      expect((await buildSnapshot(cwd)).tasks[0].prNumber).toBe(2);
      expect(gh.getBranchPrs).toHaveBeenCalledTimes(2);
      expect(gh.getIssueReferencedPrs).toHaveBeenCalledTimes(2);
      await buildSnapshot(`${cwd}-other`);
      expect(gh.getBranchPrs).toHaveBeenCalledTimes(3);
      expect(gh.getIssueReferencedPrs).toHaveBeenCalledTimes(3);
    } finally { now.mockRestore(); }
  });
  it.each(["branch", "worktree"])("fetches history when only a local %s remains", async (resource) => {
    const cwd = `/repo-${fixture}`;
    vi.mocked(gh.listPrs).mockResolvedValue([]);
    vi.mocked(listLocks).mockResolvedValue([]);
    vi.mocked(exec).mockImplementation(async (_cmd, args) => ({ code: 0, stderr: "", stdout:
      args?.[0] === "worktree"
        ? resource === "worktree" ? `worktree ${process.cwd()}/src\nbranch refs/heads/task/1-task\n\n` : ""
        : resource === "branch" ? "task/1-task\n" : "" }));
    await buildSnapshot(cwd);
    expect(gh.getBranchPrs).toHaveBeenCalledOnce();
    expect(gh.getBranchPrs).toHaveBeenCalledWith("task/1-task", { cwd });
    expect(gh.getIssueReferencedPrs).toHaveBeenCalledOnce();
    expect(gh.getIssueReferencedPrs).toHaveBeenCalledWith(1, { cwd });
  });
  it.each(["CLOSED", "MERGED"])("observes %s PR history for a retained lock after the local branch was removed", async (state) => {
    vi.mocked(gh.listPrs).mockResolvedValue([]);
    vi.mocked(exec).mockResolvedValue({ code: 0, stderr: "", stdout: "" });
    vi.mocked(gh.getBranchPrs).mockResolvedValue([{ number: 2, state, headRefName: "task/1-task", body: "", title: "pr", headSha: "a", htmlUrl: "" }]);
    const task = (await buildSnapshot(`/repo-${fixture}`)).tasks[0];
    expect(task.health.kind).toBe(state === "CLOSED" ? "needs-attention" : "inconsistent");
    expect(task.recoveryCommand).toBe("orch repair 1");
    expect(gh.getBranchPrs).toHaveBeenCalledOnce();
    expect(gh.getBranchPrs).toHaveBeenCalledWith("task/1-task", { cwd: `/repo-${fixture}` });
  });
  it.each(["getBranchPrs", "getIssueReferencedPrs"] as const)("does not cache a failed %s observation", async (lookup) => {
    vi.mocked(gh.listPrs).mockImplementation(async () => []);
    vi.mocked(gh[lookup]).mockRejectedValueOnce(new Error("PR lookup unavailable"));
    const cwd = `/repo-${fixture}`;
    const task = (await buildSnapshot(cwd)).tasks[0];
    expect(task.health).toMatchObject({ kind: "inconsistent", violations: expect.arrayContaining([
      expect.objectContaining({ detail: expect.stringContaining("PR lookup unavailable") }),
    ]) });
    expect(task.recoveryCommand).toBe("orch repair 1");
    expect((await buildSnapshot(cwd)).tasks[0].health).toEqual({ kind: "in-progress" });
    expect(gh.getBranchPrs).toHaveBeenCalledTimes(2);
    expect(gh.getIssueReferencedPrs).toHaveBeenCalledTimes(2);
  });
  it("finds closed PRs by body after an issue rename, while ignoring unrelated mentions", async () => {
    vi.mocked(gh.listPrs).mockResolvedValue([]);
    vi.mocked(exec).mockResolvedValue({ code: 0, stderr: "", stdout: "" });
    const pr = { number: 2, state: "CLOSED", headRefName: "custom", body: "Closes #1", title: "pr", headSha: "a", htmlUrl: "" };
    vi.mocked(gh.getIssueReferencedPrs).mockResolvedValue([pr, { ...pr, number: 3, body: "Mentions #1", state: "OPEN" }]);
    const task = (await buildSnapshot(`/repo-${fixture}`)).tasks[0];
    expect(task.health).toEqual({ kind: "needs-attention", reason: "pr-closed", recovery: "inspect-closed-pr" });
    expect(task.prNumber).toBe(2);
    expect(gh.getIssueReferencedPrs).toHaveBeenCalledOnce();
    expect(gh.getIssueReferencedPrs).toHaveBeenCalledWith(1, { cwd: `/repo-${fixture}` });
  });
  it("observes an unlocked worktree's issue and branch even without an open issue", async () => {
    vi.mocked(gh.listIssues).mockResolvedValue([]);
    vi.mocked(gh.listPrs).mockResolvedValue([]);
    vi.mocked(listLocks).mockResolvedValue([]);
    vi.mocked(gh.getIssue).mockRejectedValue(new Error("missing"));
    const task = (await buildSnapshot(`/repo-${fixture}`)).tasks[0];
    expect(task.health.kind).toBe("inconsistent");
    expect(gh.getIssue).toHaveBeenCalledOnce();
    expect(git.compareBranchToBase).toHaveBeenCalledOnce();
    expect(git.compareBranchToBase).toHaveBeenCalledWith("task/1-x", expect.anything(), `/repo-${fixture}`);
  });
  it("reports comparison failure as inconsistent with a safe repair command", async () => {
    vi.mocked(git.compareBranchToBase).mockRejectedValue(new Error("comparison unavailable"));
    const task = (await buildSnapshot(`/repo-${fixture}`)).tasks[0];
    expect(task.health.kind).toBe("inconsistent");
    expect(task.recoveryCommand).toBe("orch repair 1");
  });
  it("fails explicitly when the worktree inventory cannot be observed", async () => {
    vi.mocked(exec).mockResolvedValue({ code: 1, stdout: "", stderr: "git unavailable" });
    await expect(buildSnapshot(`/repo-${fixture}`)).rejects.toThrow("cannot observe worktrees");
  });
  it("refreshes CI on the same head after expiry and isolates repositories", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(100_000);
    try {
      const cwd = `/repo-${fixture}`;
      expect((await buildSnapshot(cwd)).tasks[0].prChecks).toBe("pending");
      vi.mocked(gh.prChecksState).mockResolvedValue("pass");
      expect((await buildSnapshot(cwd)).tasks[0].prChecks).toBe("pending");
      expect(gh.prChecksState).toHaveBeenCalledOnce();
      now.mockReturnValue(111_000);
      expect((await buildSnapshot(cwd)).tasks[0].prChecks).toBe("pass");
      await buildSnapshot(`${cwd}-other`);
      expect(gh.prChecksState).toHaveBeenCalledTimes(3);
    } finally { now.mockRestore(); }
  });
});
