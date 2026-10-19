import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../src/util/exec.js";
import { claim, createOwnerToken, listPathLocks, isLocked } from "../src/git/lock.js";
import * as gh from "../src/github/github.js";
import * as wt from "../src/git/worktree.js";
import * as git from "../src/git/git.js";
import * as config from "../src/config.js";
import * as adapters from "../src/adapters/index.js";
import { claimSpecific } from "../src/tasks/service.js";
import { dispatchSpecific } from "../src/tasks/runner.js";
import { abandonCommand } from "../src/commands/abandon.js";
import { merge } from "../src/board/review.js";
import { formatReview } from "../src/board/approval.js";
import { reconcileDeps, discoverRepairIssues } from "../src/tasks/reconcile.js";

vi.mock("../src/github/github.js");
vi.mock("../src/git/worktree.js");
vi.mock("../src/adapters/index.js");
vi.mock("../src/tasks/brief.js", () => ({ buildBrief: () => "brief" }));

describe("path claim lifecycle with real git refs", () => {
  let cwd: string;
  let issue: gh.Issue;
  const cfg = { ...config.DEFAULT_CONFIG, baseBranch: "main" };
  beforeEach(async () => {
    vi.resetAllMocks();
    cwd = mkdtempSync(join(tmpdir(), "orch-path-lifecycle-"));
    await exec("git", ["init", "-qb", "main"], { cwd });
    await exec("git", ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "--allow-empty", "-qm", "init"], { cwd });
    issue = { number: 42, title: "Assets", body: '## Ticket metadata (v2)\n\n```json\n{"kind":"asset","locks":["assets/**","scenes/main.scene"]}\n```',
      state: "OPEN", labels: ["status:todo", "agent:codex"], assignees: [] };
    vi.mocked(gh.getIssue).mockImplementation(async () => structuredClone(issue));
    vi.mocked(gh.listIssues).mockImplementation(async () => [structuredClone(issue)]);
    vi.mocked(gh.listPrs).mockResolvedValue([]);
    vi.mocked(gh.listOpenPrs).mockResolvedValue([]);
    vi.mocked(gh.currentLogin).mockResolvedValue("tester");
    vi.mocked(gh.editIssue).mockImplementation(async (_number, edit) => {
      issue.labels = [...new Set([...issue.labels.filter((label) => !edit.removeLabels?.includes(label)), ...edit.addLabels ?? []])];
      if (edit.addAssignees?.includes("@me")) issue.assignees.push("tester");
      if (edit.removeAssignees?.includes("@me")) issue.assignees = [];
    });
    vi.mocked(wt.observeWorktree).mockResolvedValue({ outcome: "absent" });
    vi.mocked(wt.addWorktree).mockResolvedValue({ path: cwd, branch: "task/42-assets" });
    vi.mocked(wt.worktreePath).mockReturnValue(cwd);
    vi.mocked(wt.removeWorktree).mockResolvedValue(true);
    vi.mocked(wt.worktreeRemovalSafety).mockResolvedValue({ removable: true });
    vi.mocked(wt.branchName).mockReturnValue("task/42-assets");
    vi.mocked(wt.slugify).mockReturnValue("assets");
  });
  afterEach(() => { vi.restoreAllMocks(); rmSync(cwd, { recursive: true, force: true }); });

  async function expectReleased() {
    expect(await isLocked(42, { cwd })).toBe(false);
    expect(await listPathLocks({ cwd })).toEqual([]);
  }

  it("rolls back every path ref when worktree creation fails", async () => {
    vi.mocked(wt.addWorktree).mockRejectedValue(new Error("setup failure"));
    await expect(claimSpecific(42, "codex", cfg, cwd)).rejects.toThrow("setup failure");
    await expectReleased();
  });

  it("returns a normal unavailable result on targeted dispatch when a path is held", async () => {
    await claim(7, { cwd, paths: ["assets/hero.png"] });
    expect(await dispatchSpecific(42, cfg, cwd)).toMatchObject({ outcome: "requeued", durationMs: 0 });
    expect(await isLocked(42, { cwd })).toBe(false);
    expect(adapters.makeAdapter).not.toHaveBeenCalled();
    expect(gh.editIssue).not.toHaveBeenCalled();
  });

  it.each([true, false])("releases only after safe runner recovery (removed=%s)", async (removed) => {
    vi.spyOn(git, "countCommitsAhead").mockResolvedValue(0);
    vi.mocked(wt.removeWorktree).mockResolvedValue(removed);
    vi.mocked(adapters.makeAdapter).mockReturnValue({ id: "codex", healthCheck: async () => true, runTask: vi.fn(async () => ({ ok: false, code: 1, durationMs: 1 })) });
    expect(await dispatchSpecific(42, cfg, cwd)).toMatchObject({ outcome: "failed" });
    if (removed) await expectReleased();
    else expect(await listPathLocks({ cwd })).toHaveLength(2);
  });

  it("releases the full claim on abandon", async () => {
    await claimSpecific(42, "codex", cfg, cwd);
    vi.spyOn(config, "loadConfig").mockReturnValue(cfg);
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    await abandonCommand("42", { agent: "codex" });
    await expectReleased();
  });

  it("releases the full claim on merge", async () => {
    await claimSpecific(42, "codex", cfg, cwd);
    const head = "a".repeat(40);
    vi.mocked(gh.getPr).mockResolvedValue({ number: 99, title: "Assets", body: "Closes #42", state: "OPEN", headRefName: "task/42-assets", headSha: head, htmlUrl: "" });
    vi.mocked(gh.listPrReviews).mockResolvedValue([{ id: 1, state: "COMMENTED", commit_id: head,
      body: formatReview({ reviewer: "claude", pr: 99, head, decision: "approve", timestamp: new Date().toISOString() }, "ok") }]);
    vi.mocked(gh.prChecksPass).mockResolvedValue({ pass: true, detail: "ok" });
    await merge(99, cfg, cwd);
    await expectReleased();
  });

  it("discovers and reports orphaned path refs from Git after losing an issue ref", async () => {
    const sha = await createOwnerToken(42, "codex", { cwd });
    await claim(42, { cwd, sha, paths: ["assets/**"] });
    await exec("git", ["update-ref", "-d", "refs/orch/lock/issue-42"], { cwd });
    vi.mocked(gh.listIssues).mockResolvedValue([]);
    vi.mocked(gh.getIssue).mockRejectedValue(new Error("missing"));
    expect(await discoverRepairIssues(cwd)).toContain(42);
    const observed = await reconcileDeps.observe(42, cfg, cwd);
    expect(observed.pathLocks).toMatchObject([{ issue: 42, path: "assets/**", owner: sha }]);
  });
});
