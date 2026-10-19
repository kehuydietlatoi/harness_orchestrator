import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { formatReview, parseReview } from "../src/board/approval.js";
vi.mock("../src/github/github.js", () => ({
  getPr: vi.fn(), getIssue: vi.fn(), listPrReviews: vi.fn(), recordPrReview: vi.fn(),
  prChangedPaths: vi.fn(),
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
  vi.mocked(gh.prChangedPaths).mockResolvedValue([]);
  vi.mocked(gh.getPr).mockResolvedValue(pr);
  vi.mocked(gh.getIssue).mockResolvedValue(issue);
  vi.mocked(gh.listPrReviews).mockResolvedValue([{ id: 1, state: "COMMENTED", commit_id: head,
    body: formatReview({ reviewer: "claude", pr: 62, head, timestamp: "2026-09-09T12:00:00Z", decision: "approve" }, "ok") }]);
  vi.mocked(gh.prChecksPass).mockResolvedValue({ pass: true, detail: "ok" });
});
describe("review and merge boundary", () => {
  it.each(["package.json", "vitest.config.ts", "jest.config.cjs", ".mocharc.json", "playwright.config.js", "orch.config.json", "packages/game/package.json"])("requires lead approval for %s", async (path) => {
    vi.mocked(gh.prChangedPaths).mockResolvedValue([path]);
    const setApproval = (tier?: "standard" | "lead", family = "anthropic", approvedHead = head) =>
      vi.mocked(gh.listPrReviews).mockResolvedValue([{ id: 1, state: "COMMENTED", commit_id: approvedHead,
        body: formatReview({ reviewer: "claude", tier, family, pr: 62, head: approvedHead,
          timestamp: "2026-10-19T12:00:00Z", decision: "approve" }, "ok") }]);
    for (const cfg of [DEFAULT_CONFIG, { ...DEFAULT_CONFIG, requireCrossReview: false }]) {
      for (const tier of [undefined, "standard"] as const) {
        setApproval(tier);
        const gate = await checkMergeGate(62, cfg, "/repo");
        expect(gate.ok).toBe(false);
        expect(gate.reasons.join(" ")).toContain(`lead-tier approval: ${path}`);
      }
      setApproval("lead", "openai");
      expect((await checkMergeGate(62, cfg, "/repo")).ok).toBe(false);
      setApproval("lead", "anthropic", "b".repeat(40));
      expect((await checkMergeGate(62, cfg, "/repo")).ok).toBe(false);
      setApproval("lead");
      expect((await checkMergeGate(62, cfg, "/repo")).ok).toBe(true);
    }
  });
  it("uses configured protected paths and fails closed on unavailable files or a changing head", async () => {
    vi.mocked(gh.prChangedPaths).mockResolvedValue(["scripts/check.js"]);
    expect((await checkMergeGate(62, DEFAULT_CONFIG, "/repo")).ok).toBe(true);
    expect((await checkMergeGate(62, { ...DEFAULT_CONFIG, protectedPaths: ["scripts/**"] }, "/repo")).ok).toBe(false);
    vi.mocked(gh.prChangedPaths).mockRejectedValueOnce(new Error("offline"));
    expect((await checkMergeGate(62, DEFAULT_CONFIG, "/repo")).reasons.join(" ")).toContain("cannot check protected verify paths");
    vi.mocked(gh.getPr).mockResolvedValueOnce(pr).mockResolvedValueOnce({ ...pr, headSha: "b".repeat(40) });
    expect((await checkMergeGate(62, DEFAULT_CONFIG, "/repo")).reasons.join(" ")).toContain("head changed");
  });
  it("manual review writers include tier and model family", async () => {
    await approve(62, "claude", "/repo", "ok", head, { cfg: DEFAULT_CONFIG });
    await requestChanges(62, "claude", "/repo", "fix", { cfg: DEFAULT_CONFIG });
    for (const call of vi.mocked(gh.recordPrReview).mock.calls) {
      expect(parseReview({ id: 1, state: "COMMENTED", commit_id: head, body: call[2] }))
        .toMatchObject({ tier: "lead", family: "anthropic" });
    }
  });
  it("refuses ineligible manual approvals before changing records or labels", async () => {
    for (const identity of [{ tier: "free" as const, family: "anthropic" },
      { tier: "cheap" as const, family: "anthropic" }, { tier: "standard" as const, family: "openai" }]) {
      await expect(approve(62, "claude", "/repo", "ok", head, { cfg: DEFAULT_CONFIG, identity })).rejects.toThrow(/premium/);
    }
    expect(gh.recordPrReview).not.toHaveBeenCalled();
    expect(gh.editIssue).not.toHaveBeenCalled();
  });
  it.each(["free", "cheap"] as const)("never merges a %s approval", async (tier) => {
    vi.mocked(gh.listPrReviews).mockResolvedValue([{ id: 1, state: "COMMENTED", commit_id: head,
      body: formatReview({ reviewer: "claude", tier, family: "anthropic", pr: 62, head,
        timestamp: "2026-10-18T12:00:00Z", decision: "approve" }, "ok") }]);
    expect((await checkMergeGate(62, DEFAULT_CONFIG, "/repo")).ok).toBe(false);
  });
  it("excludes a current-head request-changes decision from the queue", async () => {
    vi.mocked(gh.listOpenPrs).mockResolvedValue([pr]);
    vi.mocked(gh.listIssues).mockResolvedValue([{ ...issue, labels: ["agent:codex", "status:in-progress"] }]);
    vi.mocked(gh.listPrReviews).mockResolvedValue([{ id: 2, state: "COMMENTED", commit_id: head,
      body: formatReview({ reviewer: "claude", pr: 62, head, timestamp: "2026-09-09T12:00:00Z", decision: "request-changes" }, "fix") }]);
    expect(await reviewQueue("claude", "/repo")).toEqual([]);
  });
  it("skips review reads when review-needed explicitly queues the PR", async () => {
    vi.mocked(gh.listOpenPrs).mockResolvedValue([pr]);
    vi.mocked(gh.listIssues).mockResolvedValue([{ ...issue, labels: ["agent:codex", "review:needed"] }]);
    expect(await reviewQueue("claude", "/repo")).toHaveLength(1);
    expect(gh.listPrReviews).not.toHaveBeenCalled();
  });
  it("does not queue an unreviewed PR without a review-needed projection", async () => {
    vi.mocked(gh.listOpenPrs).mockResolvedValue([pr]);
    vi.mocked(gh.listIssues).mockResolvedValue([{ ...issue, labels: ["agent:codex"] }]);
    vi.mocked(gh.listPrReviews).mockResolvedValue([]);
    expect(await reviewQueue("claude", "/repo")).toEqual([]);
  });
  it("queues stale approval records even when their label is absent", async () => {
    vi.mocked(gh.listOpenPrs).mockResolvedValue([{ ...pr, headSha: "b".repeat(40) }]);
    vi.mocked(gh.listIssues).mockResolvedValue([{ ...issue, labels: ["agent:codex"] }]);
    expect(await reviewQueue("claude", "/repo")).toHaveLength(1);
  });
  it("queues an orphaned approval label but skips a current approval", async () => {
    vi.mocked(gh.listOpenPrs).mockResolvedValue([pr]);
    vi.mocked(gh.listIssues).mockResolvedValue([issue]);
    expect(await reviewQueue("claude", "/repo")).toEqual([]);
    vi.mocked(gh.listPrReviews).mockResolvedValue([]);
    expect(await reviewQueue("claude", "/repo")).toHaveLength(1);
  });
  it("keeps revoked approvals out of the queue even if their labels remain", async () => {
    const previous = await gh.listPrReviews(62, { cwd: "/repo" });
    vi.mocked(gh.listPrReviews).mockResolvedValue([...previous, { id: 2, state: "COMMENTED", commit_id: head,
      body: formatReview({ reviewer: "claude", pr: 62, head, timestamp: "2026-09-09T12:00:00Z", decision: "request-changes" }, "fix") }]);
    vi.mocked(gh.listOpenPrs).mockResolvedValue([pr]);
    vi.mocked(gh.listIssues).mockResolvedValue([issue]);
    expect(await reviewQueue("claude", "/repo")).toEqual([]);
    vi.mocked(gh.listOpenPrs).mockResolvedValue([{ ...pr, headSha: "b".repeat(40) }]);
    vi.mocked(gh.listIssues).mockResolvedValue([{ ...issue, labels: ["agent:codex"] }]);
    expect(await reviewQueue("claude", "/repo")).toEqual([]);
  });
  it("treats a marked self-approval as done under cross-or-self, and still queues it under cross", async () => {
    const selfApproval = { id: 3, state: "COMMENTED", commit_id: head,
      body: formatReview({ reviewer: "claude", pr: 62, head, timestamp: "2026-09-09T12:00:00Z", decision: "approve", mode: "self" }, "ok") };
    vi.mocked(gh.listOpenPrs).mockResolvedValue([pr]);
    vi.mocked(gh.listIssues).mockResolvedValue([{ ...issue, labels: ["agent:claude", "reviewed-by:claude"] }]);
    vi.mocked(gh.listPrReviews).mockResolvedValue([selfApproval]);

    expect(await reviewQueue("codex", "/repo", "cross-or-self")).toEqual([]);
    expect(await reviewQueue("codex", "/repo", "cross")).toHaveLength(1);
    expect(await reviewQueue("codex", "/repo")).toHaveLength(1); // strict by default
  });
  it("never lets an unmarked author approval take a PR out of the queue", async () => {
    const unmarked = { id: 3, state: "COMMENTED", commit_id: head,
      body: formatReview({ reviewer: "claude", pr: 62, head, timestamp: "2026-09-09T12:00:00Z", decision: "approve" }, "ok") };
    vi.mocked(gh.listOpenPrs).mockResolvedValue([pr]);
    vi.mocked(gh.listIssues).mockResolvedValue([{ ...issue, labels: ["agent:claude", "reviewed-by:claude"] }]);
    vi.mocked(gh.listPrReviews).mockResolvedValue([unmarked]);

    expect(await reviewQueue("codex", "/repo", "cross-or-self")).toHaveLength(1);
  });
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
    expect(gh.mergePr).toHaveBeenCalledWith(62, { cwd: "/repo", method: "squash", expectedHead: head, title: "task" });
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
