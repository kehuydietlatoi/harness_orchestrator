import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log } from "../src/util/log.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { loadPack } from "../src/pack/load.js";
import * as board from "../src/board/board.js";
import type { Issue } from "../src/github/github.js";

const mocks = vi.hoisted(() => ({
  assertNoExternalLinks: vi.fn(),
  resolveBaseBranch: vi.fn(),
  exec: vi.fn(),
  getIssue: vi.fn(),
  editIssue: vi.fn(),
  createPr: vi.fn(),
  currentLogin: vi.fn(),
}));

vi.mock("../src/git/worktree.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/git/worktree.js")>(),
  assertNoExternalLinks: mocks.assertNoExternalLinks,
}));
vi.mock("../src/git/git.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/git/git.js")>(),
  resolveBaseBranch: mocks.resolveBaseBranch,
}));
vi.mock("../src/util/exec.js", () => ({ exec: mocks.exec }));
vi.mock("../src/github/github.js", () => ({
  getIssue: mocks.getIssue,
  editIssue: mocks.editIssue,
  createPr: mocks.createPr,
  currentLogin: mocks.currentLogin,
}));

const { claimNext, claimSpecific, submit } = await import("../src/tasks/service.js");
const { exec: realExec } = await vi.importActual<typeof import("../src/util/exec.js")>("../src/util/exec.js");

it("skips stale models before runner preflight and continues to the next candidate", async () => {
  const stale: Issue = { number: 9, title: "stale", body: "", state: "OPEN", assignees: [],
    labels: ["agent:opencode", "effort:free", "model:outage/sim-free"] };
  const healthy = { ...stale, number: 10, labels: ["agent:opencode", "effort:free"] };
  const eligible = vi.spyOn(board, "eligibleIssues").mockResolvedValue([stale, healthy]);
  const canClaim = vi.fn(() => false);
  try {
    await expect(claimNext("opencode", DEFAULT_CONFIG, "/repo", { canClaim })).resolves.toBeNull();
    expect(canClaim.mock.calls).toEqual([[healthy]]);
    expect(mocks.getIssue).not.toHaveBeenCalled();
    expect(mocks.editIssue).not.toHaveBeenCalled();
  } finally { eligible.mockRestore(); }
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertNoExternalLinks.mockReset();
  mocks.resolveBaseBranch.mockResolvedValue({
    name: "release/v2",
    ref: "refs/remotes/origin/release/v2",
  });
  mocks.exec.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  mocks.getIssue.mockResolvedValue({
    number: 37,
    title: "Repository base",
    body: "",
    state: "OPEN",
    labels: [],
    assignees: [],
  });
  mocks.createPr.mockResolvedValue("https://example.test/pull/37");
  mocks.editIssue.mockResolvedValue(undefined);
});

describe("submit base branch", () => {
  it("refuses a real external node_modules link and posts the shared refusal", async () => {
    const { assertNoExternalLinks } = await vi.importActual<typeof import("../src/git/worktree.js")>("../src/git/worktree.js");
    const root = mkdtempSync(join(tmpdir(), "orch-submit-links-"));
    const wt = join(root, "worktree");
    const outside = join(root, "outside");
    mkdirSync(wt); mkdirSync(outside);
    const link = join(wt, "node_modules");
    symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    mocks.assertNoExternalLinks.mockImplementation(assertNoExternalLinks);
    try {
      let reason = "";
      try { assertNoExternalLinks(wt); } catch (error) { reason = (error as Error).message; }
      await expect(submit(37, "codex", DEFAULT_CONFIG, wt)).rejects.toThrow(reason);
      expect(mocks.exec).toHaveBeenCalledTimes(1);
      expect(mocks.exec).toHaveBeenCalledWith("gh", ["issue", "comment", "37", "--body-file", "-"], { cwd: wt, input: reason });
      expect(reason).toContain(JSON.stringify(outside));
      expect(mocks.createPr).not.toHaveBeenCalled();
      expect(mocks.editIssue).toHaveBeenCalledWith(37, expect.objectContaining({ addLabels: ["needs-attention"] }));
    } finally { unlinkSync(link); rmSync(root, { recursive: true, force: true }); }
  });

  it("uses the GitHub branch name rather than its local comparison ref", async () => {
    const cfg = { ...DEFAULT_CONFIG, baseBranch: "release/v2" };

    await expect(submit(37, "codex", cfg, "/repo")).resolves.toBe(
      "https://example.test/pull/37",
    );

    expect(mocks.resolveBaseBranch).toHaveBeenCalledWith("release/v2", "/repo");
    expect(mocks.createPr).toHaveBeenCalledWith(
      expect.objectContaining({ base: "release/v2" }),
    );
  });

  it("validates the base before pushing", async () => {
    mocks.resolveBaseBranch.mockRejectedValueOnce(new Error("base branch is missing"));

    await expect(submit(37, "codex", DEFAULT_CONFIG, "/repo")).rejects.toThrow(/missing/);

    expect(mocks.exec).not.toHaveBeenCalled();
    expect(mocks.createPr).not.toHaveBeenCalled();
  });
});

describe("submit scope guard", () => {
  const pack = loadPack("test/fixtures/pack");
  const cfg = { ...DEFAULT_CONFIG, pack: pack.path, loadedPack: pack };
  it.each(["design/deleted.md", "outside/renamed.ts"])("refuses %s before pushing or opening a PR", async path => {
    mocks.getIssue.mockResolvedValue({ number: 37, title: "t", body: "", labels: ["role:gameplay-programmer"] });
    mocks.exec.mockImplementation(async (_cmd, args) => ({ code: 0, stderr: "", stdout: args[0] === "diff" ? `src/old.ts\0${path}\0` : "" }));
    await expect(submit(37, "codex", cfg, "/repo")).rejects.toThrow(path);
    expect(mocks.exec).toHaveBeenCalledWith("git", ["diff", "--name-only", "--no-renames", "-z", "refs/remotes/origin/release/v2...HEAD", "--"], expect.anything());
    expect(mocks.exec.mock.calls.some(([, args]) => args[0] === "push")).toBe(false);
    expect(mocks.createPr).not.toHaveBeenCalled();
    expect(mocks.editIssue).toHaveBeenCalledWith(37, expect.objectContaining({ addLabels: ["needs-attention"] }));
    expect(mocks.exec).toHaveBeenCalledWith("gh", ["issue", "comment", "37", "--body-file", "-"], expect.objectContaining({ input: expect.stringContaining(path) }));
  });
  it("allows ticket files outside the manifest scope", async () => {
    mocks.getIssue.mockResolvedValue({ number: 37, title: "t", body: "**Files (ownership hint):** `README.md`", labels: ["role:gameplay-programmer"] });
    mocks.exec.mockImplementation(async (_cmd, args) => ({ code: 0, stderr: "", stdout: args[0] === "diff" ? "README.md\0" : "" }));
    await expect(submit(37, "codex", cfg, "/repo")).resolves.toContain("pull/37");
  });
  it("does no path lookup for a pack issue without a role label", async () => {
    await submit(37, "codex", cfg, "/repo");
    expect(mocks.exec.mock.calls.some(([, args]) => args[0] === "diff")).toBe(false);
  });
});

describe("re-claim base branch", () => {
  it("surfaces candidate claim errors instead of reporting an empty queue", async () => {
    const issue: Issue = { number: 37, title: "Repository base", body: "", state: "OPEN", labels: ["status:todo"], assignees: [] };
    const eligible = vi.spyOn(board, "eligibleIssues").mockResolvedValue([issue]);
    mocks.getIssue.mockRejectedValueOnce(new Error("temporary issue read failure"));
    try {
      await expect(claimNext("codex", DEFAULT_CONFIG, "/repo")).rejects.toThrow("temporary issue read failure");
    } finally { eligible.mockRestore(); }
  });

  it("retries a ref-lock fetch failure once before claiming from the refreshed base", async () => {
    const root = mkdtempSync(join(tmpdir(), "orch-claim-fetch-"));
    const repo = join(root, "repo");
    const origin = join(root, "origin");
    mkdirSync(origin);
    const git = async (cwd: string, ...args: string[]) => {
      const result = await realExec("git", args, { cwd });
      if (result.code !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    try {
      await git(origin, "init", "-b", "main");
      await git(origin, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "base");
      await git(root, "clone", origin, repo);
      const tip = await git(origin, "rev-parse", "HEAD");
      let fetches = 0;
      let reread = false;
      mocks.exec.mockImplementation(async (cmd, args, opts) => {
        if (args[0] === "fetch" && ++fetches === 1) {
          return { code: 1, stdout: "", stderr: "error: cannot lock ref 'refs/remotes/origin/main': is at abc but expected def" };
        }
        if (fetches === 1 && args[0] === "rev-parse" && args.includes("refs/remotes/origin/main")) reread = true;
        return realExec(cmd, args, opts);
      });
      const { resolveBaseBranch } = await vi.importActual<typeof import("../src/git/git.js")>("../src/git/git.js");
      mocks.resolveBaseBranch.mockImplementation((name, cwd, opts) => resolveBaseBranch(name, cwd, opts));
      const issue: Issue = { number: 37, title: "Repository base", body: "", state: "OPEN", labels: ["status:todo"], assignees: [] };
      mocks.getIssue.mockImplementation(async () => structuredClone(issue));
      mocks.currentLogin.mockResolvedValue("tester");
      mocks.editIssue.mockImplementation(async (_number, edit) => {
        issue.labels = issue.labels.filter(label => !edit.removeLabels?.includes(label));
        issue.labels.push(...edit.addLabels ?? []);
        if (edit.addAssignees) issue.assignees = ["tester"];
      });
      const claimed = await claimSpecific(37, "codex", { ...DEFAULT_CONFIG, baseBranch: "main", worktreeRoot: "wt" }, repo);
      expect(claimed).not.toBeNull();
      expect(fetches).toBe(2);
      expect(reread).toBe(true);
      expect(await git(claimed!.worktree.path, "rev-parse", "HEAD")).toBe(tip);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([false, true])("refreshes only branches without their own commits (own work: %s)", async ownWork => {
    const repo = mkdtempSync(join(tmpdir(), "orch-reclaim-"));
    const git = async (...args: string[]) => {
      const result = await realExec("git", args, { cwd: repo });
      if (result.code !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    const warning = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      await git("init", "-b", "main");
      await git("config", "user.name", "Test");
      await git("config", "user.email", "test@example.test");
      await git("commit", "--allow-empty", "-m", "original base");
      const branch = "task/37-repository-base";
      await git("branch", branch);
      if (ownWork) {
        await git("checkout", branch);
        await git("commit", "--allow-empty", "-m", "task work");
        await git("checkout", "main");
      }
      const oldTip = await git("rev-parse", branch);
      await git("commit", "--allow-empty", "-m", "new base");
      const baseTip = await git("rev-parse", "HEAD");
      await git("update-ref", "refs/remotes/origin/main", baseTip);
      mocks.resolveBaseBranch.mockResolvedValue({ name: "main", ref: "refs/remotes/origin/main" });
      mocks.exec.mockImplementation(realExec);
      const issue: Issue = { number: 37, title: "Repository base", body: "", state: "OPEN", labels: ["status:todo"], assignees: [] };
      mocks.getIssue.mockImplementation(async () => structuredClone(issue));
      mocks.currentLogin.mockResolvedValue("tester");
      mocks.editIssue.mockImplementation(async (_number, edit) => {
        issue.labels = issue.labels.filter(label => !edit.removeLabels?.includes(label));
        issue.labels.push(...edit.addLabels ?? []);
        if (edit.addAssignees) issue.assignees = ["tester"];
      });

      const claimed = await claimSpecific(37, "codex", { ...DEFAULT_CONFIG, worktreeRoot: "wt" }, repo);

      expect(claimed).not.toBeNull();
      expect(await git("rev-parse", branch)).toBe(ownWork ? oldTip : baseTip);
      expect(await git("-C", claimed!.worktree.path, "rev-parse", "HEAD")).toBe(ownWork ? oldTip : baseTip);
      if (ownWork) expect(warning).toHaveBeenCalledWith(expect.stringMatching(/task\/37-repository-base.*behind/));
    } finally {
      warning.mockRestore();
      // The entire disposable repository, including its linked worktree, lives here.
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
