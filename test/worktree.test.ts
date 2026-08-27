import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../src/util/exec.js";
import {
  addWorktree,
  discardWorktree,
  observeWorktree,
  removeWorktree,
  worktreePath,
} from "../src/git/worktree.js";

async function makeRepo(): Promise<{ base: string; repo: string }> {
  const base = mkdtempSync(join(tmpdir(), "orch-worktree-"));
  const repo = join(base, "repo");
  mkdirSync(repo);
  await exec("git", ["init", "-q", "-b", "main"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "# test\n");
  writeFileSync(join(repo, ".gitignore"), "ignored.txt\n");
  await exec("git", ["add", "-A"], { cwd: repo });
  await exec(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"],
    { cwd: repo },
  );
  return { base, repo };
}

function options(repo: string) {
  return { cwd: repo, baseRef: "refs/heads/main" };
}

describe("task worktrees", () => {
  let base: string;
  let repo: string;

  beforeEach(async () => {
    ({ base, repo } = await makeRepo());
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("rejects an existing task path that Git does not register as a worktree", async () => {
    const path = worktreePath("../wt", 29, repo);
    const recoverable = join(path, "recoverable.txt");
    mkdirSync(path, { recursive: true });
    writeFileSync(recoverable, "keep me\n");

    await expect(addWorktree(29, "Identity safe", "../wt", options(repo))).rejects.toThrow(
      /not registered/i,
    );
    expect(existsSync(recoverable)).toBe(true);
  });

  it("observes an expected registered task worktree without mutating it", async () => {
    const worktree = await addWorktree(29, "Identity safe", "../wt", options(repo));

    expect(await observeWorktree(29, "Identity safe", "../wt", { cwd: repo })).toEqual({
      outcome: "usable",
      worktree,
    });
  });

  it("creates a task branch from the explicit repository base", async () => {
    await exec("git", ["branch", "stable"], { cwd: repo });
    writeFileSync(join(repo, "later.txt"), "not on stable\n");
    await exec("git", ["add", "-A"], { cwd: repo });
    await exec(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "later"],
      { cwd: repo },
    );

    const worktree = await addWorktree(29, "Explicit base", "../wt", {
      cwd: repo,
      baseRef: "refs/heads/stable",
    });

    expect(existsSync(join(worktree.path, "later.txt"))).toBe(false);
  });

  it("reports an existing unregistered task path as a conflict", async () => {
    const path = worktreePath("../wt", 29, repo);
    mkdirSync(path, { recursive: true });

    const observation = await observeWorktree(29, "Identity safe", "../wt", { cwd: repo });

    expect(observation.outcome).toBe("conflict");
  });

  it("rejects a registered task path attached to a different branch", async () => {
    const path = worktreePath("../wt", 29, repo);
    await exec("git", ["worktree", "add", "-q", "-b", "task/99-other", path], { cwd: repo });

    await expect(addWorktree(29, "Identity safe", "../wt", options(repo))).rejects.toThrow(
      /task\/99-other.*task\/29-identity-safe/i,
    );
    expect(existsSync(join(path, "README.md"))).toBe(true);
  });

  it("keeps failed-task tracked modifications during safe cleanup", async () => {
    const worktree = await addWorktree(29, "Identity safe", "../wt", options(repo));
    const recoverable = join(worktree.path, "README.md");
    writeFileSync(recoverable, "recoverable edit\n");

    expect(await removeWorktree(worktree.path, { cwd: repo })).toBe(false);
    expect(existsSync(recoverable)).toBe(true);
  });

  it("keeps failed-task untracked files during safe cleanup", async () => {
    const worktree = await addWorktree(29, "Identity safe", "../wt", options(repo));
    const recoverable = join(worktree.path, "untracked.txt");
    writeFileSync(recoverable, "recoverable file\n");

    expect(await removeWorktree(worktree.path, { cwd: repo })).toBe(false);
    expect(existsSync(recoverable)).toBe(true);
  });

  it("keeps failed-task ignored files during safe cleanup", async () => {
    const worktree = await addWorktree(29, "Identity safe", "../wt", options(repo));
    const recoverable = join(worktree.path, "ignored.txt");
    writeFileSync(recoverable, "recoverable ignored file\n");

    expect(await removeWorktree(worktree.path, { cwd: repo })).toBe(false);
    expect(existsSync(recoverable)).toBe(true);
  });

  it("keeps a failed-task detached worktree during safe cleanup", async () => {
    const worktree = await addWorktree(29, "Identity safe", "../wt", options(repo));
    await exec("git", ["checkout", "--detach", "-q"], { cwd: worktree.path });

    expect(await removeWorktree(worktree.path, { cwd: repo })).toBe(false);
    expect(existsSync(worktree.path)).toBe(true);
  });

  it("keeps failed-task commits that are not preserved by another ref", async () => {
    const worktree = await addWorktree(29, "Identity safe", "../wt", options(repo));
    writeFileSync(join(worktree.path, "work.txt"), "recoverable commit\n");
    await exec("git", ["add", "-A"], { cwd: worktree.path });
    await exec(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "work"],
      { cwd: worktree.path },
    );

    expect(await removeWorktree(worktree.path, { cwd: repo })).toBe(false);
    expect(existsSync(join(worktree.path, "work.txt"))).toBe(true);
  });

  it("discards recoverable work only through the explicit discard interface", async () => {
    const worktree = await addWorktree(29, "Identity safe", "../wt", options(repo));
    writeFileSync(join(worktree.path, "untracked.txt"), "discard me\n");

    expect(await discardWorktree(worktree.path, { cwd: repo })).toBe(true);
    expect(existsSync(worktree.path)).toBe(false);
  });

  it("removes a clean attached worktree whose HEAD is preserved elsewhere", async () => {
    const worktree = await addWorktree(29, "Identity safe", "../wt", options(repo));

    expect(await removeWorktree(worktree.path, { cwd: repo })).toBe(true);
    expect(existsSync(worktree.path)).toBe(false);
  });
});
