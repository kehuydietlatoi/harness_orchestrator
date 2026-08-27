import { beforeEach, describe, expect, it, vi } from "vitest";

const execMock = vi.fn();
vi.mock("../src/util/exec.js", () => ({ exec: (...args: unknown[]) => execMock(...args) }));

const {
  compareBranchToBase,
  countCommitsAhead,
  resolveBaseBranch,
} = await import("../src/git/git.js");

const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
const missing = () => ({ code: 1, stdout: "", stderr: "" });

beforeEach(() => vi.clearAllMocks());

describe("resolveBaseBranch", () => {
  it.each(["main", "master"])("accepts a configured local %s branch", async (name) => {
    execMock.mockImplementation(async (_cmd: string, args: string[]) => {
      if (args[0] === "check-ref-format") return ok();
      if (args.at(-1) === `refs/heads/${name}`) return ok();
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
