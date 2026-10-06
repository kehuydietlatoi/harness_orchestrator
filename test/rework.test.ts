import { beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { Issue, PrReview } from "../src/github/github.js";
import { formatReview, latestChangesRequestedNote } from "../src/board/approval.js";
import { buildBrief } from "../src/tasks/brief.js";
import { addReworkWorktree } from "../src/git/worktree.js";
import { resolveDispatchAgent } from "../src/tasks/runner.js";

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  getIssue: vi.fn(),
  editIssue: vi.fn(),
  createPr: vi.fn(),
  getBranchPrs: vi.fn(),
  resolveBaseBranch: vi.fn(),
}));

vi.mock("../src/util/exec.js", async (orig) => {
  const real = await orig<typeof import("../src/util/exec.js")>();
  return { ...real, exec: (...args: Parameters<typeof real.exec>) => mocks.exec(...args) };
});
vi.mock("../src/github/github.js", async (orig) => {
  const real = await orig<typeof import("../src/github/github.js")>();
  return {
    ...real,
    getIssue: mocks.getIssue,
    editIssue: mocks.editIssue,
    createPr: mocks.createPr,
    getBranchPrs: mocks.getBranchPrs,
  };
});
vi.mock("../src/git/git.js", () => ({ resolveBaseBranch: mocks.resolveBaseBranch }));

const { submit } = await import("../src/tasks/service.js");

const HEAD = "a".repeat(40);
const issue: Issue = {
  number: 68,
  title: "Rework dispatch",
  body: "spec",
  state: "OPEN",
  labels: ["status:in-progress", "agent:claude"],
  assignees: [],
};

function review(id: number, decision: "approve" | "request-changes", note: string, head = HEAD): PrReview {
  return {
    id,
    state: "COMMENTED",
    commit_id: head,
    body: formatReview(
      { reviewer: "codex", pr: 7, head, timestamp: new Date().toISOString(), decision },
      note,
    ),
  };
}

describe("rework eligibility", () => {
  it("allows an in-progress issue only when rework is observed", () => {
    const open = new Map([[68, issue]]);
    expect(() => resolveDispatchAgent(issue, open, DEFAULT_CONFIG)).toThrow(/not a todo/);
    expect(resolveDispatchAgent(issue, open, DEFAULT_CONFIG, { rework: true })).toBe("claude");
  });

  it("keeps routing and dependency guards for rework", () => {
    const blocked = { ...issue, body: "Depends-on: #3" };
    const dep = { ...issue, number: 3 };
    expect(() =>
      resolveDispatchAgent(blocked, new Map([[68, blocked], [3, dep]]), DEFAULT_CONFIG, { rework: true }),
    ).toThrow(/blocked by/);
  });

  it("extracts the latest request-changes note bound to the current head", () => {
    const reviews = [review(1, "request-changes", "old"), review(2, "request-changes", "Fix the race.")];
    expect(latestChangesRequestedNote(reviews, 7, HEAD)).toBe("Fix the race.");
  });

  it("returns null when approved later, for a stale head, or without records", () => {
    expect(latestChangesRequestedNote([review(1, "request-changes", "x"), review(2, "approve", "ok")], 7, HEAD)).toBeNull();
    expect(latestChangesRequestedNote([review(1, "request-changes", "x")], 7, "b".repeat(40))).toBeNull();
    expect(latestChangesRequestedNote([], 7, HEAD)).toBeNull();
  });
});

describe("rework brief", () => {
  const wt = { path: "/wt/issue-68", branch: "task/68-rework-dispatch" };

  it("includes the review notes and the merge-not-rebase instruction", () => {
    const text = buildBrief(issue, wt, "claude", "/nonexistent", {
      pr: 7,
      notes: "Fix the race.",
      baseRef: "refs/remotes/origin/main",
    });
    expect(text).toContain("Fix the race.");
    expect(text).toContain("PR #7");
    expect(text).toContain("git merge origin/main");
    expect(text).toContain("not rebasing");
    expect(text).toContain("no new PR");
  });

  it("is unchanged for a fresh task", () => {
    const text = buildBrief(issue, wt, "claude", "/nonexistent");
    expect(text).not.toContain("Rework requested");
    expect(text).toContain("opens a PR");
  });
});

describe("submit with an existing PR", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveBaseBranch.mockResolvedValue({ name: "main", ref: "refs/heads/main" });
    mocks.exec.mockImplementation(async (_cmd: string, args: string[]) =>
      args[0] === "rev-parse"
        ? { code: 0, stdout: "task/68-rework-dispatch\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" },
    );
    mocks.getIssue.mockResolvedValue(issue);
    mocks.editIssue.mockResolvedValue(undefined);
  });

  it("pushes without force and re-projects in-review without creating a PR", async () => {
    mocks.getBranchPrs.mockResolvedValue([
      { number: 7, state: "OPEN", htmlUrl: "https://example.test/pull/7", headRefName: "task/68-rework-dispatch" },
    ]);

    await expect(submit(68, "claude", DEFAULT_CONFIG, "/repo")).resolves.toBe("https://example.test/pull/7");

    const push = mocks.exec.mock.calls.find(([, args]) => args[0] === "push");
    expect(push?.[1]).toEqual(["push", "-u", "origin", "HEAD"]);
    expect(mocks.createPr).not.toHaveBeenCalled();
    expect(mocks.editIssue).toHaveBeenCalledWith(
      68,
      expect.objectContaining({ addLabels: ["status:in-review", "review:needed"] }),
    );
  });

  it("still creates a PR when none is open for the branch", async () => {
    mocks.getBranchPrs.mockResolvedValue([{ number: 5, state: "MERGED", htmlUrl: "u" }]);
    mocks.createPr.mockResolvedValue("https://example.test/pull/9");
    await expect(submit(68, "claude", DEFAULT_CONFIG, "/repo")).resolves.toBe("https://example.test/pull/9");
  });
});

describe("addReworkWorktree", () => {
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

  beforeEach(() => {
    mocks.exec.mockImplementation(async (cmd: string, args: string[], opts: { cwd?: string } = {}) => {
      try {
        const stdout = execFileSync(cmd, args, { cwd: opts.cwd, encoding: "utf8", stdio: "pipe" });
        return { code: 0, stdout, stderr: "" };
      } catch (e) {
        const err = e as { status?: number; stderr?: string };
        return { code: err.status ?? 1, stdout: "", stderr: String(err.stderr ?? "") };
      }
    });
  });

  it("attaches the existing PR branch and fast-forwards it to origin", async () => {
    const root = mkdtempSync(join(tmpdir(), "orch-rework-"));
    const origin = join(root, "origin.git");
    const repo = join(root, "repo");
    git(root, "init", "--bare", "-b", "main", origin);
    git(root, "clone", origin, repo);
    git(repo, "config", "user.email", "t@example.test");
    git(repo, "config", "user.name", "t");
    git(repo, "switch", "-c", "main");
    writeFileSync(join(repo, "a.txt"), "a");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "base");
    git(repo, "push", "origin", "main");

    const branch = "task/68-rework-dispatch";
    git(repo, "switch", "-c", branch);
    writeFileSync(join(repo, "b.txt"), "b");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "work");
    git(repo, "push", "origin", branch);
    const prHead = git(repo, "rev-parse", "HEAD");
    git(repo, "switch", "main");
    git(repo, "branch", "-D", branch); // only the remote PR branch remains

    const wt = await addReworkWorktree(68, "Rework dispatch", "wt", { branch, cwd: repo });

    expect(wt.branch).toBe(branch);
    expect(wt.head).toBe(prHead);
    expect(existsSync(join(wt.path, "b.txt"))).toBe(true);
    expect(git(wt.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(branch);
  });

  it("rejects a PR branch that is not the task branch", async () => {
    await expect(
      addReworkWorktree(68, "Rework dispatch", "wt", { branch: "feature/other", cwd: process.cwd() }),
    ).rejects.toThrow(/not the task branch/);
  });
});
