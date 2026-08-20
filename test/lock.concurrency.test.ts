import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../src/util/exec.js";
import { claim, release, isLocked, listLocks } from "../src/lock.js";

/** Create a throwaway git repo with a single commit; return its path. */
async function makeRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "orch-lock-"));
  await exec("git", ["init", "-q", "-b", "main"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# test\n");
  await exec("git", ["add", "-A"], { cwd: dir });
  await exec(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"],
    { cwd: dir },
  );
  return dir;
}

describe("atomic claim (git ref mutex)", () => {
  let repo: string;
  beforeEach(async () => {
    repo = await makeRepo();
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("lets exactly one of many racers win the same issue", async () => {
    const racers = 25;
    const results = await Promise.all(
      Array.from({ length: racers }, () => claim(101, { cwd: repo })),
    );
    const acquired = results.filter((r) => r.outcome === "acquired");
    const held = results.filter((r) => r.outcome === "already-held");
    const errored = results.filter((r) => r.outcome === "error");

    expect(errored, JSON.stringify(errored)).toHaveLength(0);
    expect(acquired).toHaveLength(1);
    expect(held).toHaveLength(racers - 1);
    expect(await isLocked(101, { cwd: repo })).toBe(true);
  });

  it("is idempotent-safe: release frees the issue for re-claim", async () => {
    expect((await claim(7, { cwd: repo })).outcome).toBe("acquired");
    expect((await claim(7, { cwd: repo })).outcome).toBe("already-held");
    expect(await release(7, { cwd: repo })).toBe(true);
    expect(await isLocked(7, { cwd: repo })).toBe(false);
    expect((await claim(7, { cwd: repo })).outcome).toBe("acquired");
  });

  it("tracks distinct claims independently", async () => {
    await claim(1, { cwd: repo });
    await claim(2, { cwd: repo });
    await claim(3, { cwd: repo });
    const locks = (await listLocks({ cwd: repo })).sort((a, b) => a - b);
    expect(locks).toEqual([1, 2, 3]);
  });
});
