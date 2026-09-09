import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { formatReview } from "../src/board/approval.js";
vi.mock("../src/github/github.js", () => ({
  getPr: vi.fn(), getIssue: vi.fn(), listPrReviews: vi.fn(), recordPrReview: vi.fn(),
  editIssue: vi.fn(), prChecksPass: vi.fn(), mergePr: vi.fn(), listIssues: vi.fn(), listOpenPrs: vi.fn(),
}));
vi.mock("../src/git/worktree.js", () => ({ worktreePath: () => "/worktree", removeWorktree: vi.fn() }));
vi.mock("../src/git/lock.js", () => ({ release: vi.fn() }));
import * as gh from "../src/github/github.js";
import { removeWorktree } from "../src/git/worktree.js";
import { approve, checkMergeGate, merge, requestChanges, reviewQueue } from "../src/board/review.js";
const head = "a".repeat(40);
const issue = { number: 38, title: "task", body: "", state: "OPEN", labels: ["agent:codex", "reviewed-by:claude"], assignees: [] };
const pr = { number: 62, title: "task", body: "Closes #38", state: "OPEN", headSha: head, headRefName: "task/38-task", htmlUrl: "" };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(gh.getPr).mockResolvedValue(pr);
  vi.mocked(gh.getIssue).mockResolvedValue(issue);
  vi.mocked(gh.listPrReviews).mockResolvedValue([{ id: 1, state: "COMMENTED", commit_id: head,
    body: formatReview({ reviewer: "claude", pr: 62, head, timestamp: "2026-09-09T12:00:00Z", decision: "approve" }, "ok") }]);
  vi.mocked(gh.prChecksPass).mockResolvedValue({ pass: true, detail: "ok" });
});
describe("review and merge boundary", () => {
  it("requires structured approval even if a legacy label exists", async () => {
    vi.mocked(gh.listPrReviews).mockResolvedValue([]);
    expect((await checkMergeGate(62, DEFAULT_CONFIG, "/repo")).ok).toBe(false);
  });
  it("rejects stale approval after a push", async () => {
    vi.mocked(gh.getPr).mockResolvedValue({ ...pr, headSha: "b".repeat(40) });
    expect((await checkMergeGate(62, DEFAULT_CONFIG, "/repo")).ok).toBe(false);
    vi.mocked(gh.listOpenPrs).mockResolvedValue([{ ...pr, headSha: "b".repeat(40) }]);
    vi.mocked(gh.listIssues).mockResolvedValue([issue]);
    expect(await reviewQueue("claude", "/repo")).toHaveLength(1);
  });
  it("passes the validated SHA to merge and preserves work when the server rejects a race", async () => {
    vi.mocked(gh.mergePr).mockRejectedValue(new Error("head changed"));
    await expect(merge(62, DEFAULT_CONFIG, "/repo")).rejects.toThrow("head changed");
    expect(gh.mergePr).toHaveBeenCalledWith(62, { cwd: "/repo", method: "squash", expectedHead: head });
    expect(removeWorktree).not.toHaveBeenCalled();
  });
  it("rejects approval of a different head before writing", async () => {
    await expect(approve(62, "claude", "/repo", "", "b".repeat(40))).rejects.toThrow("--head");
    expect(gh.recordPrReview).not.toHaveBeenCalled();
  });
  it("records approval before projecting labels and fails closed on write error", async () => {
    vi.mocked(gh.recordPrReview).mockRejectedValueOnce(new Error("offline"));
    await expect(approve(62, "claude", "/repo", "ok", head)).rejects.toThrow("offline");
    expect(gh.editIssue).not.toHaveBeenCalled();
    await approve(62, "claude", "/repo", "ok", head);
    expect(gh.editIssue).toHaveBeenCalledOnce();
  });
  it("records revocation and clears projected approvals on changes requested", async () => {
    await requestChanges(62, "claude", "/repo", "fix");
    expect(gh.recordPrReview).toHaveBeenCalledWith(62, head, expect.stringContaining('"decision":"request-changes"'), { cwd: "/repo" });
    expect(gh.editIssue).toHaveBeenCalledWith(38, expect.objectContaining({ removeLabels: expect.arrayContaining(["reviewed-by:claude"]) }));
  });
});
