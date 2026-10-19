import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../src/util/exec.js";
import { log } from "../src/util/log.js";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, unlinkSync: vi.fn(fs.unlinkSync), readdirSync: vi.fn(fs.readdirSync) };
});
import {
  addWorktree,
  blockingStatusEntries,
  discardWorktree,
  observeWorktree,
  removeWorktree,
  worktreePath,
  worktreeRemovalSafety,
} from "../src/git/worktree.js";

async function makeRepo(): Promise<{ base: string; repo: string }> {
  const base = mkdtempSync(join(tmpdir(), "orch-worktree-"));
  const repo = join(base, "repo");
  mkdirSync(repo);
  await exec("git", ["init", "-q", "-b", "main"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "# test\n");
  writeFileSync(join(repo, ".gitignore"), "ignored.txt\nnode_modules/\n");
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
    vi.restoreAllMocks();
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

  it("removes a worktree whose only extra files are disposable ignored output", async () => {
    const worktree = await addWorktree(29, "Identity safe", "../wt", options(repo));
    mkdirSync(join(worktree.path, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(worktree.path, "node_modules", "pkg", "index.js"), "regenerable\n");

    expect(await worktreeRemovalSafety(worktree.path, `refs/heads/${worktree.branch}`)).toEqual({ removable: true });
    expect(await removeWorktree(worktree.path, { cwd: repo })).toBe(true);
    expect(existsSync(worktree.path)).toBe(false);
  });

  // POSIX Git treats a top-level symlink as a file, so node_modules/ does
  // not ignore it. A junction is a directory to Windows Git. The nested case
  // exercises default disposable-directory cleanup on both platforms.
  for (const location of [
    ...(process.platform === "win32" ? ["node_modules"] : []),
    "node_modules/pkg/external",
  ]) {
    it(`preserves the target of a real directory link at ${location} during safe removal`, async () => {
      const worktree = await addWorktree(29, "Link safe", "../wt", options(repo));
      const target = join(base, "external");
      mkdirSync(target);
      writeFileSync(join(target, "sentinel.txt"), "keep all contents\n");
      const link = join(worktree.path, location);
      mkdirSync(join(link, ".."), { recursive: true });
      symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");

      expect(await removeWorktree(worktree.path, { cwd: repo })).toBe(true);
      expect(readFileSync(join(target, "sentinel.txt"), "utf8")).toBe("keep all contents\n");
      expect(existsSync(worktree.path)).toBe(false);
    });
  }

  for (const location of ["node_modules", "node_modules/pkg/external", "external"]) {
    it(`preserves a real link target at ${location} during forced discard`, async () => {
      const worktree = await addWorktree(29, "Link safe", "../wt", options(repo));
      const target = join(base, "external");
      mkdirSync(join(target, "nested"), { recursive: true });
      writeFileSync(join(target, "nested", "sentinel.txt"), "keep all contents\n");
      const link = join(worktree.path, location);
      mkdirSync(join(link, ".."), { recursive: true });
      symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");

      expect(await discardWorktree(worktree.path, { cwd: repo })).toBe(true);
      expect(readFileSync(join(target, "nested", "sentinel.txt"), "utf8")).toBe("keep all contents\n");
      expect(existsSync(worktree.path)).toBe(false);
    });
  }

  it("retains and names links outside disposable paths during safe cleanup", async () => {
    const worktree = await addWorktree(29, "Link safe", "../wt", options(repo));
    const target = join(base, "external");
    mkdirSync(target);
    writeFileSync(join(target, "sentinel.txt"), "keep me\n");
    for (const name of ["external", "ignored.txt"]) {
      symlinkSync(target, join(worktree.path, name), process.platform === "win32" ? "junction" : "dir");
    }

    const safety = await worktreeRemovalSafety(worktree.path, `refs/heads/${worktree.branch}`);
    expect(safety.removable).toBe(false);
    expect(safety.reason).toContain("external");
    expect(safety.reason).toContain("ignored.txt");
    expect(await removeWorktree(worktree.path, { cwd: repo })).toBe(false);
    expect(readFileSync(join(target, "sentinel.txt"), "utf8")).toBe("keep me\n");
    expect(lstatSync(join(worktree.path, "external")).isSymbolicLink()).toBe(true);
  });

  for (const remove of [removeWorktree, discardWorktree]) {
    it(`${remove.name} retains the worktree and names a link that cannot be unlinked`, async () => {
      const worktree = await addWorktree(29, "Link safe", "../wt", options(repo));
      const target = join(base, "external");
      mkdirSync(target);
      writeFileSync(join(target, "sentinel.txt"), "keep me\n");
      mkdirSync(join(worktree.path, "node_modules"));
      const link = join(worktree.path, "node_modules", "external");
      symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
      const warning = vi.spyOn(log, "warn").mockImplementation(() => {});
      vi.mocked(unlinkSync).mockImplementationOnce(() => { throw new Error("access denied"); });

      expect(await remove(worktree.path, { cwd: repo })).toBe(false);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining(`cannot safely unlink ${link}`));
      expect(existsSync(worktree.path)).toBe(true);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(target, "sentinel.txt"), "utf8")).toBe("keep me\n");
    });
  }

  it("retains the worktree and names an unreadable directory during inspection", async () => {
    const worktree = await addWorktree(29, "Link safe", "../wt", options(repo));
    vi.mocked(readdirSync).mockImplementationOnce(() => { throw new Error("access denied"); });
    const safety = await worktreeRemovalSafety(worktree.path, `refs/heads/${worktree.branch}`);
    expect(safety.removable).toBe(false);
    expect(safety.reason).toContain(`cannot safely inspect ${worktree.path}`);
    expect(existsSync(worktree.path)).toBe(true);
  });

  it("does not enter cyclic or dangling links inside disposable output", async () => {
    const worktree = await addWorktree(29, "Link safe", "../wt", options(repo));
    const output = join(worktree.path, "node_modules");
    mkdirSync(output);
    const type = process.platform === "win32" ? "junction" : "dir";
    symlinkSync(worktree.path, join(output, "cycle"), type);
    symlinkSync(join(base, "missing"), join(output, "dangling"), type);

    expect(await removeWorktree(worktree.path, { cwd: repo })).toBe(true);
    expect(existsSync(worktree.path)).toBe(false);
  });

  it("retains a worktree root that is itself a link", async () => {
    const worktree = await addWorktree(29, "Link safe", "../wt", options(repo));
    const original = readFileSync(join(worktree.path, "README.md"), "utf8");
    const alias = join(base, "alias");
    symlinkSync(worktree.path, alias, process.platform === "win32" ? "junction" : "dir");
    const warning = vi.spyOn(log, "warn").mockImplementation(() => {});

    const safety = await worktreeRemovalSafety(alias, `refs/heads/${worktree.branch}`);
    expect(safety.removable).toBe(false);
    expect(safety.reason).toContain("worktree root is a link");
    expect(await discardWorktree(alias, { cwd: repo })).toBe(false);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining(alias));
    expect(readFileSync(join(worktree.path, "README.md"), "utf8")).toBe(original);
  });

  it("keeps a worktree with disposable output plus a non-disposable ignored file, naming it", async () => {
    const worktree = await addWorktree(29, "Identity safe", "../wt", options(repo));
    mkdirSync(join(worktree.path, "node_modules"));
    writeFileSync(join(worktree.path, "node_modules", "x.js"), "regenerable\n");
    writeFileSync(join(worktree.path, "ignored.txt"), "local secret\n");

    const safety = await worktreeRemovalSafety(worktree.path, `refs/heads/${worktree.branch}`);
    expect(safety.removable).toBe(false);
    expect(safety.reason).toContain("ignored.txt");
    expect(safety.reason).not.toContain("node_modules");
    expect(await removeWorktree(worktree.path, { cwd: repo })).toBe(false);
    expect(existsSync(join(worktree.path, "ignored.txt"))).toBe(true);
  });

  it("honours a configured allowlist instead of the defaults", async () => {
    const worktree = await addWorktree(29, "Identity safe", "../wt", options(repo));
    writeFileSync(join(worktree.path, "ignored.txt"), "build stamp\n");
    mkdirSync(join(worktree.path, "node_modules"));
    writeFileSync(join(worktree.path, "node_modules", "x.js"), "regenerable\n");

    // node_modules/ is no longer disposable, ignored.txt now is.
    expect(await removeWorktree(worktree.path, { cwd: repo, disposableIgnored: ["ignored.txt"] })).toBe(false);
    rmSync(join(worktree.path, "node_modules"), { recursive: true, force: true });
    expect(await removeWorktree(worktree.path, { cwd: repo, disposableIgnored: ["ignored.txt"] })).toBe(true);
  });
});

describe("blockingStatusEntries", () => {
  const disposable = ["node_modules/", "dist/", "build.stamp"];

  it("treats allowlisted ignored paths as disposable", () => {
    expect(blockingStatusEntries("!! node_modules/\n!! dist/\n!! build.stamp\n", disposable)).toEqual([]);
  });

  it("blocks dirty, untracked, non-allowlisted, nested, and quoted entries", () => {
    const porcelain = [
      " M src/a.ts",
      "?? notes.txt",
      "!! .env",
      "!! packages/app/node_modules/",
      "!! node_modules_backup/",
      '!! "we\\303\\251ird/"',
      "!! dist/",
    ].join("\n");
    expect(blockingStatusEntries(porcelain, disposable)).toEqual([
      " M src/a.ts",
      "?? notes.txt",
      "!! .env",
      "!! packages/app/node_modules/",
      "!! node_modules_backup/",
      '!! "we\\303\\251ird/"',
    ]);
  });

  it("does not let a directory allowlist entry match a same-prefix file", () => {
    expect(blockingStatusEntries("!! dist.txt\n", ["dist/"])).toEqual(["!! dist.txt"]);
  });
});
