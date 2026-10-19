import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../src/util/exec.js";
import { claim, createOwnerToken, isLocked, listLocks, listPathLocks, owner, pathsLocked, release, releaseOwned } from "../src/git/lock.js";
import { lockPathsOverlap } from "../src/git/path-locks.js";

describe("exclusive path claims with real refs", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), "orch-path-lock-"));
    expect((await exec("git", ["init", "-q"], { cwd })).code).toBe(0);
    expect((await exec("git", ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "--allow-empty", "-qm", "init"], { cwd })).code).toBe(0);
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it("acquires the whole set or none and releases paths with their issue", async () => {
    expect((await claim(1, { cwd, paths: ["assets/**", "scenes/main.scene"] })).outcome).toBe("acquired");
    expect(await listLocks({ cwd })).toEqual([1]);
    expect(await listPathLocks({ cwd })).toHaveLength(2);
    expect((await claim(2, { cwd, paths: ["free.txt", "assets/hero.png"] })).outcome).toBe("already-held");
    expect(await isLocked(2, { cwd })).toBe(false);
    expect(await pathsLocked(["free.txt"], { cwd })).toBe(false);
    expect(await release(1, { cwd })).toBe(true);
    expect(await listPathLocks({ cwd })).toEqual([]);
    expect((await claim(2, { cwd, paths: ["assets/hero.png"] })).outcome).toBe("acquired");
  });

  it("serializes concurrent overlapping glob claims without holding unrelated paths", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => claim(i + 1, {
      cwd, paths: [i % 2 ? "assets/*/hero.png" : "assets/characters/*.png"],
    })));
    expect(results.filter((r) => r.outcome === "acquired")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "already-held")).toHaveLength(11);
    expect(await listLocks({ cwd })).toHaveLength(1);
    expect(await listPathLocks({ cwd })).toHaveLength(1);
    expect((await claim(100, { cwd, paths: ["docs/**"] })).outcome).toBe("acquired");
  });

  it("compare-deletes paths only with the matching claim owner", async () => {
    const first = await createOwnerToken(1, "codex", { cwd });
    const other = await createOwnerToken(1, "claude", { cwd });
    await claim(1, { cwd, sha: first, paths: ["./assets\\hero.png"] });
    expect(await releaseOwned(1, other, { cwd })).toBe(false);
    expect(await owner(1, { cwd })).toBe(first);
    expect(await listPathLocks({ cwd })).toHaveLength(1);
    expect(await releaseOwned(1, first, { cwd })).toBe(true);
    expect(await listPathLocks({ cwd })).toEqual([]);
  });

  it("rolls back path refs and the version update if the issue create loses", async () => {
    await claim(1, { cwd });
    expect((await claim(1, { cwd, paths: ["assets/**", "scenes/**"] })).outcome).toBe("already-held");
    expect(await listPathLocks({ cwd })).toEqual([]);
    expect((await claim(2, { cwd, paths: ["assets/**"] })).outcome).toBe("acquired");
  });

  it("retries concurrent independent additions without keeping a global mutex", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => claim(i + 1, { cwd, paths: [`area-${i}/**`] })));
    expect(results.map((r) => r.outcome)).toEqual(Array(6).fill("acquired"));
    expect(await listPathLocks({ cwd })).toHaveLength(6);
  });
});

describe("lock glob intersection", () => {
  it.each([
    ["assets/**", "assets/a.png", true],
    ["assets/**/hero.png", "assets/hero.png", true],
    // A literal path can name a directory containing a matching descendant.
    ["assets/**/hero.png", "assets/prefixhero.png", true],
    ["assets/*/hero.png", "assets/characters/*.png", true],
    ["assets/hero?.png", "assets/hero1.*", true],
    ["scenes", "scenes/main.scene", true],
    ["assets/*.png", "assets/*.jpg", false],
    ["assets/*.png", "docs/*.png", false],
    ["assets/*/hero.png", "assets/a/b/hero.png", false],
    ["assets/{hero,villain}.png", "assets/villain.*", true],
    ["assets/{hero,villain}.png", "assets/tree.*", false],
    ["assets/hero[0-9].png", "assets/hero[5-8].png", true],
    ["assets/hero[!0-9].png", "assets/hero[5-8].png", false],
  ])("%s overlaps %s = %s", (a, b, expected) => {
    expect(lockPathsOverlap(a, b)).toBe(expected);
    expect(lockPathsOverlap(b, a)).toBe(expected);
  });
});
