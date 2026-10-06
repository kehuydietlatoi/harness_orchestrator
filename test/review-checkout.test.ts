import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareReviewCheckout } from "../src/board/review-run.js";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** Real git: this logic is about checkouts, which a mock would only restate. */
describe("prepareReviewCheckout", () => {
  let repo = "";
  let first = "";
  let second = "";

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "orch-checkout-repo-"));
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@example.com");
    git(repo, "config", "user.name", "t");
    git(repo, "config", "commit.gpgsign", "false");
    writeFileSync(join(repo, "file.txt"), "reviewed revision\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "first");
    first = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "file.txt"), "a later, different revision\n");
    git(repo, "commit", "-q", "-am", "second");
    second = git(repo, "rev-parse", "HEAD");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("checks out exactly the requested commit even when the repository is on a different one", async () => {
    expect(git(repo, "rev-parse", "HEAD")).toBe(second); // the repo checkout is NOT the PR head

    const checkout = await prepareReviewCheckout({ number: 7, headSha: first }, repo);
    try {
      expect(git(checkout.path, "rev-parse", "HEAD")).toBe(first);
      // autocrlf may rewrite line endings on Windows; the revision is what matters.
      expect(readFileSync(join(checkout.path, "file.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("reviewed revision\n");
      expect(checkout.path).not.toBe(repo);
    } finally {
      await checkout.release();
    }
  });

  it("leaves the repository checkout untouched", async () => {
    const checkout = await prepareReviewCheckout({ number: 7, headSha: first }, repo);
    await checkout.release();

    expect(git(repo, "rev-parse", "HEAD")).toBe(second);
    expect(git(repo, "branch", "--show-current")).toBe("main");
    expect(readFileSync(join(repo, "file.txt"), "utf8")).toBe("a later, different revision\n");
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("removes the directory and unregisters the worktree on release", async () => {
    const checkout = await prepareReviewCheckout({ number: 7, headSha: first }, repo);
    expect(git(repo, "worktree", "list")).toContain(checkout.path.replace(/\\/g, "/"));

    await checkout.release();

    expect(existsSync(checkout.path)).toBe(false);
    expect(git(repo, "worktree", "list")).not.toContain("orch-review-7");
  });

  it("gives each call its own checkout", async () => {
    const a = await prepareReviewCheckout({ number: 7, headSha: first }, repo);
    const b = await prepareReviewCheckout({ number: 7, headSha: second }, repo);
    try {
      expect(a.path).not.toBe(b.path);
      expect(git(a.path, "rev-parse", "HEAD")).toBe(first);
      expect(git(b.path, "rev-parse", "HEAD")).toBe(second);
    } finally {
      await a.release();
      await b.release();
    }
  });

  it("fails closed when the commit does not exist and cannot be fetched, leaving no stray directory", async () => {
    const missing = "f".repeat(40);
    await expect(prepareReviewCheckout({ number: 7, headSha: missing }, repo)).rejects.toThrow(
      /PR #7 head ffffffff is not available locally and could not be fetched/,
    );
    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1);
  });

  it("fails closed and cleans up when the checkout cannot be created", async () => {
    // A real commit that is not a valid worktree target: the git runner reports a failed `worktree add`.
    const calls: string[][] = [];
    const failing = async (args: string[], cwd: string) => {
      calls.push(args);
      if (args[0] === "worktree" && args[1] === "add") return { code: 128, stdout: "", stderr: "fatal: boom" };
      return { code: 0, stdout: "", stderr: "" };
    };

    await expect(prepareReviewCheckout({ number: 7, headSha: first }, repo, failing)).rejects.toThrow(
      /could not check out PR #7 head .*fatal: boom/,
    );
    expect(calls.some((a) => a[0] === "worktree" && a[1] === "remove")).toBe(true); // cleanup attempted
  });

  it("refuses a checkout whose HEAD is not the requested commit", async () => {
    const lying = async (args: string[]) => {
      if (args[0] === "rev-parse") return { code: 0, stdout: `${second}\n`, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    await expect(prepareReviewCheckout({ number: 7, headSha: first }, repo, lying)).rejects.toThrow(
      /is not at the PR head/,
    );
  });
});
