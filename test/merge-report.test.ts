import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config.js";
import { formatReview } from "../src/board/approval.js";

const paths = vi.hoisted(() => ({ worktree: "" }));
vi.mock("../src/github/github.js", () => ({
  getPr: vi.fn(), getIssue: vi.fn(), listPrReviews: vi.fn(), recordPrReview: vi.fn(),
  editIssue: vi.fn(), prChecksPass: vi.fn(), mergePr: vi.fn(), listIssues: vi.fn(), listOpenPrs: vi.fn(),
}));
vi.mock("../src/git/worktree.js", () => ({ worktreePath: () => paths.worktree, removeWorktree: vi.fn() }));
vi.mock("../src/git/lock.js", () => ({ release: vi.fn() }));
import * as gh from "../src/github/github.js";
import { removeWorktree } from "../src/git/worktree.js";
import { merge } from "../src/board/review.js";

const head = "a".repeat(40);
const issue = { number: 65, title: "task", body: "", state: "OPEN", labels: ["agent:claude"], assignees: [] };
const pr = { number: 72, title: "task", body: "Closes #65", state: "OPEN", headSha: head, headRefName: "task/65-task", htmlUrl: "" };

describe("merge cleanup report", () => {
  let base = "";

  beforeEach(() => {
    vi.resetAllMocks();
    base = mkdtempSync(join(tmpdir(), "orch-merge-"));
    paths.worktree = base;
    vi.mocked(gh.getPr).mockResolvedValue(pr);
    vi.mocked(gh.getIssue).mockResolvedValue(issue);
    vi.mocked(gh.listPrReviews).mockResolvedValue([{ id: 1, state: "COMMENTED", commit_id: head,
      body: formatReview({ reviewer: "codex", pr: 72, head, timestamp: "2026-10-06T12:00:00Z", decision: "approve" }, "ok") }]);
    vi.mocked(gh.prChecksPass).mockResolvedValue({ pass: true, detail: "ok" });
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it("reports a retained worktree instead of claiming it was pruned", async () => {
    vi.mocked(removeWorktree).mockResolvedValue(false);
    expect(await merge(72, DEFAULT_CONFIG, "/repo")).toEqual({ issue: 65, worktree: "retained" });
    expect(removeWorktree).toHaveBeenCalledWith(base, { cwd: "/repo", disposableIgnored: DEFAULT_CONFIG.disposableIgnored });
  });

  it("reports removal and an absent worktree accurately", async () => {
    vi.mocked(removeWorktree).mockResolvedValue(true);
    expect((await merge(72, DEFAULT_CONFIG, "/repo")).worktree).toBe("removed");
    paths.worktree = join(base, "missing");
    expect((await merge(72, DEFAULT_CONFIG, "/repo")).worktree).toBe("none");
  });
});
