import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execMock = vi.fn();
vi.mock("../src/util/exec.js", () => ({ exec: (...args: unknown[]) => execMock(...args) }));

const {
  compareBranchToBase,
  countCommitsAhead,
  resolveBaseBranch,
} = await import("../src/git/git.js");

const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
const missing = () => ({ code: 1, stdout: "", stderr: "" });
const { exec: realExec } = await vi.importActual<typeof import("../src/util/exec.js")>("../src/util/exec.js");
const { addWorktree } = await import("../src/git/worktree.js");

beforeEach(() => vi.clearAllMocks());

describe("resolveBaseBranch", () => {
  it.each(["main", "master"])("accepts a configured local %s branch", async (name) => {
    execMock.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === "check-ref-format") return ok();
      if (args.at(-1) === `refs/heads/${name}`) return ok();
      if (args.at(-1) === `refs/remotes/origin/${name}`) return missing();
      throw new Error(`unexpected command: ${args.join(" ")}`);
    });

    await expect(resolveBaseBranch(name, "/repo")).resolves.toEqual({
      name,
      ref: `refs/heads/${name}`,
    });
    expect(execMock).not.toHaveBeenCalledWith("gh", expect.anything(), expect.anything());
  });

  it("derives a custom GitHub default and uses its origin-tracking ref", async () => {
    execMock.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === "gh") return ok("release/v2\n");
      if (args[0] === "check-ref-format") return ok();
      if (args.at(-1) === "refs/heads/release/v2") return missing();
      if (args.at(-1) === "refs/remotes/origin/release/v2") return ok();
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    });

    await expect(resolveBaseBranch(undefined, "/repo")).resolves.toEqual({
      name: "release/v2",
      ref: "refs/remotes/origin/release/v2",
    });
  });

  it("rejects a base branch whose local and origin refs are missing", async () => {
    execMock.mockImplementation(async (_cmd: string, args: string[]) =>
      args[0] === "check-ref-format" ? ok() : missing(),
    );

    await expect(resolveBaseBranch("trunk", "/repo")).rejects.toThrow(
      /base branch 'trunk' is missing/,
    );
  });

  it("surfaces Git and GitHub lookup failures", async () => {
    execMock.mockResolvedValueOnce({ code: 1, stdout: "", stderr: "API unavailable" });
    await expect(resolveBaseBranch(undefined, "/repo")).rejects.toThrow(/API unavailable/);

    execMock.mockReset();
    execMock.mockResolvedValueOnce(ok()).mockResolvedValueOnce({
      code: 128,
      stdout: "",
      stderr: "fatal: cannot read refs",
    });
    await expect(resolveBaseBranch("main", "/repo")).rejects.toThrow(/cannot read refs/);
  });
});

describe("countCommitsAhead", () => {
  it("counts commits only after merge-base validates comparable history", async () => {
    execMock.mockResolvedValueOnce(ok("abc123\n")).mockResolvedValueOnce(ok("2\n"));

    await expect(countCommitsAhead("refs/heads/main", "HEAD", "/worktree")).resolves.toBe(2);
    expect(execMock.mock.calls.map((call) => call[1][0])).toEqual(["merge-base", "rev-list"]);
  });

  it.each(["merge-base", "rev-list"])("throws when git %s fails", async (command) => {
    if (command === "merge-base") {
      execMock.mockResolvedValueOnce({ code: 128, stdout: "", stderr: "bad base" });
    } else {
      execMock
        .mockResolvedValueOnce(ok("abc123\n"))
        .mockResolvedValueOnce({ code: 128, stdout: "", stderr: "bad range" });
    }

    await expect(countCommitsAhead("refs/heads/main", "HEAD", "/worktree")).rejects.toThrow(
      new RegExp(`git ${command} failed`),
    );
  });

  it("rejects malformed rev-list output instead of converting it to zero", async () => {
    execMock.mockResolvedValueOnce(ok("abc123\n")).mockResolvedValueOnce(ok("not-a-count\n"));

    await expect(countCommitsAhead("refs/heads/main", "HEAD", "/worktree")).rejects.toThrow(
      /invalid count/,
    );
  });
});

describe("compareBranchToBase", () => {
  const base = { name: "main", ref: "refs/heads/main" };

  it("represents a missing task ref as absent without running comparison commands", async () => {
    execMock.mockResolvedValueOnce(missing());

    await expect(compareBranchToBase("task/37-base", base, "/repo")).resolves.toBe("absent");
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  it("classifies valid zero and positive comparisons", async () => {
    execMock
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok("abc123\n"))
      .mockResolvedValueOnce(ok("0\n"));
    await expect(compareBranchToBase("task/37-base", base, "/repo")).resolves.toBe("unchanged");

    execMock
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok("abc123\n"))
      .mockResolvedValueOnce(ok("1\n"));
    await expect(compareBranchToBase("task/37-base", base, "/repo")).resolves.toBe("ahead");
  });
});

describe("repository base with real Git refs", () => {
  let root: string;
  let origin: string;
  let repo: string;
  async function git(cwd: string, ...args: string[]): Promise<string> {
    const result = await realExec("git", args, { cwd });
    if (result.code !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  }
  async function commit(cwd: string, message: string): Promise<string> {
    await git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com",
      "commit", "--allow-empty", "-qm", message);
    return git(cwd, "rev-parse", "HEAD");
  }
  beforeEach(async () => {
    execMock.mockImplementation(realExec);
    root = mkdtempSync(join(tmpdir(), "orch-base-"));
    origin = join(root, "origin");
    repo = join(root, "repo");
    mkdirSync(origin);
    await git(origin, "init", "-q", "-b", "studio");
    await commit(origin, "initial");
    await git(root, "clone", "-q", origin, repo);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("fetches the current origin head and starts a worktree there while local base stays behind", async () => {
    const local = await git(repo, "rev-parse", "studio");
    const latest = await commit(origin, "merged work");
    expect(await git(repo, "rev-parse", "origin/studio")).toBe(local);
    const base = await resolveBaseBranch("studio", repo, { fetch: true });
    expect(base).toEqual({ name: "studio", ref: "refs/remotes/origin/studio" });
    const worktree = await addWorktree(167, "Fresh base", "../wt", { cwd: repo, baseRef: base.ref });
    expect(await git(worktree.path, "rev-parse", "HEAD")).toBe(latest);
    expect(await git(repo, "rev-parse", "studio")).toBe(local);
    expect(await countCommitsAhead(base.ref, "HEAD", worktree.path)).toBe(0);
    await commit(worktree.path, "task work");
    expect(await countCommitsAhead(base.ref, "HEAD", worktree.path)).toBe(1);
    expect(await resolveBaseBranch("studio", repo)).toEqual(base);
  });

  it("shares concurrent base fetches across linked worktrees", async () => {
    const wt = join(root, "sibling");
    await git(repo, "worktree", "add", "-b", "sibling", wt);
    const latest = await commit(origin, "new base");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let fetches = 0;
    execMock.mockImplementation(async (cmd: string, args: string[], opts: { cwd: string }) => {
      if (args[0] === "fetch") { fetches += 1; await gate; }
      return realExec(cmd, args, opts);
    });
    const calls = [resolveBaseBranch("studio", repo, { fetch: true }), resolveBaseBranch("studio", wt, { fetch: true })];
    try {
      await vi.waitFor(() => expect(fetches).toBeGreaterThan(0));
      // Both callers have reached the shared operation before it completes.
      await new Promise(resolve => setTimeout(resolve, 100));
    } finally { release(); }
    await expect(Promise.all(calls)).resolves.toEqual([
      { name: "studio", ref: "refs/remotes/origin/studio" },
      { name: "studio", ref: "refs/remotes/origin/studio" },
    ]);
    expect(fetches).toBe(1);
    expect(await git(repo, "rev-parse", "origin/studio")).toBe(latest);
  });

  it.each(["ahead", "diverged"])("rejects a local base that is %s of origin", async relation => {
    await commit(repo, "local work");
    if (relation === "diverged") await commit(origin, "remote work");
    await expect(resolveBaseBranch("studio", repo, { fetch: true })).rejects.toThrow(
      new RegExp(`local base branch 'studio' is ${relation}`),
    );
  });

  it("fails closed when fetching fails even with cached base refs", async () => {
    await git(repo, "remote", "set-url", "origin", join(root, "missing"));
    await expect(resolveBaseBranch("studio", repo, { fetch: true })).rejects.toThrow(/git fetch.*failed/);
    expect(execMock.mock.calls.filter(([, args]) => args[0] === "fetch")).toHaveLength(1);
  });

  it("bounds ref-lock retries and allows another fetch after failure", async () => {
    let fetches = 0;
    execMock.mockImplementation(async (cmd: string, args: string[], opts: { cwd: string }) => {
      if (args[0] === "fetch" && ++fetches <= 2) {
        return { code: 1, stdout: "", stderr: "cannot lock ref 'refs/remotes/origin/studio'" };
      }
      return realExec(cmd, args, opts);
    });
    await expect(resolveBaseBranch("studio", repo, { fetch: true })).rejects.toThrow(/cannot lock ref/);
    expect(fetches).toBe(2);
    await expect(resolveBaseBranch("studio", repo, { fetch: true })).resolves.toEqual({
      name: "studio", ref: "refs/remotes/origin/studio",
    });
    expect(fetches).toBe(3);
  });
});
