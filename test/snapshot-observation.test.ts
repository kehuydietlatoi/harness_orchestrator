import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/github/github.js", () => ({ listIssues: vi.fn(), listPrs: vi.fn(), getRepoUrl: vi.fn(), prChecksState: vi.fn() }));
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
    expect(listLocks).toHaveBeenCalledWith({ cwd: `/repo-${fixture}`, strict: true });
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
