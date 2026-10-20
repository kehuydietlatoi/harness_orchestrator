import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, type OrchConfig } from "../src/config.js";
import { prepareReviewCheckout, type ReviewCheckout } from "../src/board/review-run.js";
import { exec } from "../src/util/exec.js";
import { appendEvent, readEvents } from "../src/tasks/events.js";
import { runEvidence, type EvidenceRunDeps } from "../src/tasks/evidence.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("runEvidence", () => {
  let root: string;
  let repo: string;
  let sha: string;
  let cfg: OrchConfig;
  let checkouts: ReviewCheckout[];
  let deps: EvidenceRunDeps;

  beforeEach(() => {
    vi.mocked(spawn).mockClear();
    root = mkdtempSync(join(tmpdir(), "orch-evidence-test-"));
    repo = join(root, "repo");
    mkdirSync(join(repo, "qa", "scenarios"), { recursive: true });
    copyFileSync(new URL("./fixtures/evidence.mjs", import.meta.url), join(repo, "evidence.mjs"));
    for (const [name, mode] of Object.entries({ one: "ok", two: "ok", failed: "failed", missing: "missing", mismatch: "mismatch", timeout: "timeout", invalid: "invalid", exit: "exit", false: "false" })) {
      writeFileSync(join(repo, "qa", "scenarios", `${name}.json`), JSON.stringify({ mode }));
    }
    git(repo, "init", "-q");
    git(repo, "config", "user.name", "test");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "commit.gpgsign", "false");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "evidence fixtures");
    sha = git(repo, "rev-parse", "HEAD");
    // Evidence must use the earlier SHA even with dirty author files and a newer head.
    writeFileSync(join(repo, "evidence.mjs"), "throw new Error('wrong checkout');");
    git(repo, "commit", "-qam", "later author revision");
    writeFileSync(join(repo, "dirty.txt"), "preserve me");
    cfg = { ...DEFAULT_CONFIG, evidence: [process.execPath, "evidence.mjs"], evidenceDir: join(root, "evidence"), evidenceTimeoutMs: 10000 };
    checkouts = [];
    deps = {
      runner: vi.fn(exec), appendEvent, now: Date.now,
      checkout: async (pr, cwd) => {
        const checkout = await prepareReviewCheckout(pr, cwd);
        checkouts.push(checkout);
        return checkout;
      },
    };
    vi.stubEnv("ORCH_HOME", join(root, "state"));
    vi.stubEnv("GH_TOKEN", "secret");
    vi.stubEnv("GITHUB_TOKEN", "secret");
    vi.stubEnv("GH_ENTERPRISE_TOKEN", "secret");
  });

  afterEach(async () => {
    for (const checkout of checkouts) if (existsSync(checkout.path)) await checkout.release();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  const run = (scenarios: string[]) => runEvidence({ cfg, cwd: repo, issue: 216, prNumber: 300, sha, scenarios }, deps);

  it("runs two scenarios at the exact detached head with scrubbed credentials, fresh output and events", async () => {
    const old = join(cfg.evidenceDir!, "216", sha, "one");
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, "stale.txt"), "old evidence");
    cfg.evidenceSetup = [[process.execPath, "-e", "require('fs').writeFileSync('setup.txt', process.cwd())"]];
    const { checkout, results } = await run(["one", "two"]);
    expect(results.map(r => r.status)).toEqual(["ok", "ok"]);
    expect(existsSync(join(old, "stale.txt"))).toBe(false);
    expect(git(checkout.path, "branch", "--show-current")).toBe("");
    expect(git(checkout.path, "rev-parse", "HEAD")).toBe(sha);
    expect(checkout.path).not.toBe(repo);
    expect(readFileSync(join(checkout.path, "setup.txt"), "utf8")).toBe(realpathSync(checkout.path));
    for (const result of results) {
      expect(result.outDir).toBe(join(cfg.evidenceDir!, "216", sha, result.scenario));
      const info = JSON.parse(readFileSync(join(result.outDir, "info.json"), "utf8"));
      expect(info.sha).toBe(sha);
      expect(realpathSync(info.cwd)).toBe(realpathSync(checkout.path));
      for (const token of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN"]) expect(info.env[token]).toBeUndefined();
    }
    for (const [, , options] of vi.mocked(deps.runner).mock.calls) {
      expect(options).toMatchObject({ cwd: checkout.path, timeoutMs: 10000 });
      expect(options!.env!.GH_TOKEN).toBeUndefined();
    }
    const commands = vi.mocked(spawn).mock.calls.filter(([command]) => command === process.execPath);
    expect(commands).toHaveLength(3); // setup and both scenarios
    for (const call of commands) {
      expect(call[2]).toMatchObject({ shell: false, cwd: checkout.path });
    }
    expect(readEvents(repo)).toEqual(results.map(r => expect.objectContaining({
      type: "observe.evidence", issue: 216, pr: 300, sha, scenario: r.scenario, ok: true, outDir: r.outDir, durationMs: r.durationMs,
    })));
    expect(readFileSync(join(repo, "dirty.txt"), "utf8")).toBe("preserve me");
  });

  it.each([
    ["failed", "the player fell through the floor"], ["missing", "missing or invalid run.json"],
    ["invalid", "missing or invalid run.json"], ["absent", "missing scenario file"],
    ["mismatch", "SHA mismatch"], ["exit", "exit code 7: fixture output tail"],
    ["false", "did not report ok: true"],
  ])("fails clearly for %s", async (scenario, reason) => {
    const { results } = await run([scenario, "two"]);
    expect(results[0]).toMatchObject({ status: "failed", error: expect.stringContaining(reason) });
    expect(results[1].status).toBe("ok");
    expect(readEvents(repo).map(e => e.ok)).toEqual([false, true]);
  });

  it("kills a timed out command and records failure", async () => {
    cfg.evidenceTimeoutMs = 200;
    const { results } = await run(["timeout"]);
    expect(results[0]).toMatchObject({ status: "failed", error: expect.stringContaining("timed out after 200ms") });
  });

  it("fails all scenarios on setup failure without executing evidence", async () => {
    cfg.evidenceSetup = [[process.execPath, "-e", "console.error('setup broke'); process.exit(9)"], [process.execPath, "-e", "process.exit(0)"]];
    const { results } = await run(["one", "two"]);
    expect(deps.runner).toHaveBeenCalledTimes(1);
    expect(results.every(r => r.status === "failed" && r.error?.includes("setup broke") && r.error.includes("exit code 9"))).toBe(true);
    expect(readEvents(repo).map(e => e.ok)).toEqual([false, false]);
  });

  it("unlinks an internal junction before release, preserving its target", async () => {
    let checkout: ReviewCheckout;
    // Observe the target after unlink but before Git removes the checkout itself.
    const guardedGit = async (args: string[], cwd: string) => {
      if (args[0] === "worktree" && args[1] === "remove") {
        expect(existsSync(join(checkout.path, "link"))).toBe(false);
        expect(readFileSync(join(checkout.path, "target", "keep.txt"), "utf8")).toBe("preserve target");
      }
      return exec("git", args, { cwd });
    };
    deps.checkout = async (pr, cwd) => {
      checkout = await prepareReviewCheckout(pr, cwd, guardedGit);
      checkouts.push(checkout);
      return checkout;
    };
    ({ checkout } = await run(["one"]));
    const target = join(checkout.path, "target");
    mkdirSync(target);
    writeFileSync(join(target, "keep.txt"), "preserve target");
    symlinkSync(target, join(checkout.path, "link"), process.platform === "win32" ? "junction" : "dir");
    await checkout.release();
    expect(existsSync(checkout.path)).toBe(false);
  });
});
