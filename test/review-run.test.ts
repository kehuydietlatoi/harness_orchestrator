import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, type OrchConfig } from "../src/config.js";
import { formatReview } from "../src/board/approval.js";

vi.mock("../src/github/github.js", () => ({
  getPr: vi.fn(), getIssue: vi.fn(), prDiff: vi.fn(), listPrReviews: vi.fn(), recordPrReview: vi.fn(),
  editIssue: vi.fn(), prChecksPass: vi.fn(), mergePr: vi.fn(), listIssues: vi.fn(), listOpenPrs: vi.fn(),
}));
vi.mock("../src/git/worktree.js", () => ({ worktreePath: () => "/no/such/worktree", removeWorktree: vi.fn() }));
vi.mock("../src/git/lock.js", () => ({ release: vi.fn() }));
vi.mock("../src/tasks/runner.js", () => ({ resolveTaskModel: () => ({ model: "m", effort: "medium" }) }));

import * as gh from "../src/github/github.js";
import { availabilityPath, markUnavailable, unavailableUntil } from "../src/board/availability.js";
import { formatReviewPrompt, parseVerdict, runAutomatedReview, type ReviewRunDeps } from "../src/board/review-run.js";
import { checkMergeGate } from "../src/board/review.js";

const head = "a".repeat(40);
const issue = { number: 38, title: "task", body: "do the thing", state: "OPEN", labels: ["agent:claude"], assignees: [] };
const pr = { number: 62, title: "task", body: "Closes #38", state: "OPEN", headSha: head, headRefName: "task/38-task", htmlUrl: "" };
const approveText = 'Looks good.\n```json\n{"decision":"approve","notes":"meets criteria"}\n```';
const changesText = '```json\n{"decision":"request-changes","notes":"add a test for the empty case"}\n```';
const limitRaw =
  '{"type":"turn.failed","error":{"message":"You hit your usage limit. try again at 11:59 PM."}}';

function runner(results: Array<{ code?: number; text?: string; raw?: string; timedOut?: boolean }>) {
  const calls: Array<{ reviewer: string; prompt: string }> = [];
  const fn: ReviewRunDeps["runner"] = async (args) => {
    calls.push({ reviewer: args.reviewer, prompt: args.prompt });
    const r = results[calls.length - 1] ?? {};
    return { code: r.code ?? 0, timedOut: r.timedOut ?? false, text: r.text ?? "", raw: r.raw ?? "" };
  };
  return { deps: { runner: fn, now: () => new Date() } satisfies ReviewRunDeps, calls };
}

describe("parseVerdict", () => {
  it("reads an approve or request-changes decision from the last fenced block", () => {
    expect(parseVerdict(approveText)).toEqual({ decision: "approve", notes: "meets criteria" });
    expect(parseVerdict(changesText)).toEqual({ decision: "request-changes", notes: "add a test for the empty case" });
    expect(parseVerdict('{"decision":"approve"}')).toEqual({ decision: "approve", notes: "" });
  });

  it("fails closed on anything malformed", () => {
    expect(parseVerdict("")).toBeNull();
    expect(parseVerdict("LGTM")).toBeNull();
    expect(parseVerdict('```json\n{"decision":"maybe"}\n```')).toBeNull();
    expect(parseVerdict('```json\n{"decision":"request-changes","notes":"  "}\n```')).toBeNull();
  });
});

describe("formatReviewPrompt", () => {
  const base = { issue, pr, diff: "diff --git a b", author: "claude", reviewer: "codex", mode: "cross" as const };

  it("carries the issue, diff, head, and the verdict contract", () => {
    const prompt = formatReviewPrompt(base);
    expect(prompt).toContain(head);
    expect(prompt).toContain("do the thing");
    expect(prompt).toContain("diff --git a b");
    expect(prompt).toContain('"decision"');
    expect(prompt).toContain("READ-ONLY");
  });

  it("tells a self-reviewer to stay independent", () => {
    expect(formatReviewPrompt({ ...base, reviewer: "claude", mode: "self" })).toContain("fresh, independent session");
  });

  it("truncates an oversized diff", () => {
    expect(formatReviewPrompt({ ...base, diff: "x".repeat(200_000) })).toContain("diff truncated");
  });
});

describe("runAutomatedReview", () => {
  let cwd = "";
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "orch-review-run-"));
    vi.resetAllMocks();
    vi.mocked(gh.getPr).mockResolvedValue(pr);
    vi.mocked(gh.getIssue).mockResolvedValue(issue);
    vi.mocked(gh.prDiff).mockResolvedValue("diff --git a b");
    vi.mocked(gh.listPrReviews).mockResolvedValue([]);
    vi.mocked(gh.prChecksPass).mockResolvedValue({ pass: true, detail: "ok" });
  });
  afterEach(() => {
    rmSync(dirname(availabilityPath(cwd)), { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it("cross-reviews with the other harness and records an unmarked approval", async () => {
    const { deps, calls } = runner([{ text: approveText }]);
    const out = await runAutomatedReview(62, DEFAULT_CONFIG, cwd, {}, deps);

    expect(calls.map((c) => c.reviewer)).toEqual(["codex"]);
    expect(out).toMatchObject({ decision: "approve", reviewer: "codex", mode: "cross", head });
    const body = vi.mocked(gh.recordPrReview).mock.calls[0][2];
    expect(body).toContain('"reviewer":"codex"');
    expect(body).not.toContain('"mode"');
  });

  it("records request-changes and bounces the issue", async () => {
    const { deps } = runner([{ text: changesText }]);
    const out = await runAutomatedReview(62, DEFAULT_CONFIG, cwd, {}, deps);

    expect(out.decision).toBe("request-changes");
    expect(vi.mocked(gh.recordPrReview).mock.calls[0][2]).toContain('"decision":"request-changes"');
    expect(gh.editIssue).toHaveBeenCalledWith(38, expect.objectContaining({ addLabels: ["status:in-progress"] }));
  });

  it("falls back to a fresh self-review when the other harness hits its usage limit", async () => {
    const { deps, calls } = runner([{ code: 1, raw: limitRaw }, { text: approveText }]);
    const out = await runAutomatedReview(62, DEFAULT_CONFIG, cwd, {}, deps);

    expect(calls.map((c) => c.reviewer)).toEqual(["codex", "claude"]);
    expect(out).toMatchObject({ reviewer: "claude", mode: "self" });
    expect(unavailableUntil("codex", cwd)).not.toBeNull();
    expect(vi.mocked(gh.recordPrReview).mock.calls[0][2]).toContain('"mode":"self"');
  });

  it("a fallback self-approval satisfies the merge gate, an unmarked author approval does not", async () => {
    const { deps } = runner([{ code: 1, raw: limitRaw }, { text: approveText }]);
    await runAutomatedReview(62, DEFAULT_CONFIG, cwd, {}, deps);
    const selfBody = vi.mocked(gh.recordPrReview).mock.calls[0][2];
    const review = (body: string) => [{ id: 1, state: "COMMENTED", commit_id: head, body }];

    vi.mocked(gh.listPrReviews).mockResolvedValue(review(selfBody));
    expect((await checkMergeGate(62, DEFAULT_CONFIG, cwd)).ok).toBe(true);
    expect((await checkMergeGate(62, { ...DEFAULT_CONFIG, reviewPolicy: "cross" }, cwd)).ok).toBe(false);

    const forged = formatReview({ reviewer: "claude", pr: 62, head, timestamp: "2026-10-06T12:00:00Z", decision: "approve" }, "ok");
    vi.mocked(gh.listPrReviews).mockResolvedValue(review(forged));
    expect((await checkMergeGate(62, DEFAULT_CONFIG, cwd)).ok).toBe(false);
  });

  it("does not self-review under the cross policy and says when to retry", async () => {
    const cfg: OrchConfig = { ...DEFAULT_CONFIG, reviewPolicy: "cross" };
    const { deps, calls } = runner([{ code: 1, raw: limitRaw }]);

    await expect(runAutomatedReview(62, cfg, cwd, {}, deps)).rejects.toThrow(/no reviewer available.*Try again later/);
    expect(calls).toHaveLength(1);
    expect(gh.recordPrReview).not.toHaveBeenCalled();
  });

  it("skips a harness already known to be on cooldown without launching it", async () => {
    markUnavailable("codex", { resetAt: null, reason: "usage limit" }, cwd);
    const { deps, calls } = runner([{ text: approveText }]);
    const out = await runAutomatedReview(62, DEFAULT_CONFIG, cwd, {}, deps);

    expect(calls.map((c) => c.reviewer)).toEqual(["claude"]);
    expect(out.mode).toBe("self");
  });

  it("a pinned reviewer never falls back", async () => {
    const { deps, calls } = runner([{ code: 1, raw: limitRaw }]);
    await expect(runAutomatedReview(62, DEFAULT_CONFIG, cwd, { reviewer: "codex" }, deps)).rejects.toThrow(/out of usage/);
    expect(calls).toHaveLength(1);
  });

  it("a pinned self-review is refused while the other harness is available", async () => {
    const { deps } = runner([{ text: approveText }]);
    await expect(runAutomatedReview(62, DEFAULT_CONFIG, cwd, { reviewer: "claude" }, deps)).rejects.toThrow(/only a fallback/);
    expect(gh.recordPrReview).not.toHaveBeenCalled();
  });

  it("records nothing for an unparseable verdict, a crash, or a timeout", async () => {
    for (const result of [{ text: "LGTM" }, { code: 2 }, { timedOut: true, code: 1 }]) {
      const { deps } = runner([result]);
      await expect(runAutomatedReview(62, DEFAULT_CONFIG, cwd, {}, deps)).rejects.toThrow(/review by 'codex'/);
    }
    expect(gh.recordPrReview).not.toHaveBeenCalled();
  });

  it("refuses to record a verdict when the PR head moved during the review", async () => {
    vi.mocked(gh.getPr).mockResolvedValueOnce(pr).mockResolvedValue({ ...pr, headSha: "b".repeat(40) });
    const { deps } = runner([{ text: approveText }]);

    await expect(runAutomatedReview(62, DEFAULT_CONFIG, cwd, {}, deps)).rejects.toThrow(/changed during review/);
    expect(gh.recordPrReview).not.toHaveBeenCalled();
  });

  it("rejects a PR that is closed or unmapped", async () => {
    vi.mocked(gh.getPr).mockResolvedValue({ ...pr, state: "MERGED" });
    await expect(runAutomatedReview(62, DEFAULT_CONFIG, cwd, {}, runner([]).deps)).rejects.toThrow(/must be open/);
    vi.mocked(gh.getPr).mockResolvedValue({ ...pr, headRefName: "random", body: "" });
    await expect(runAutomatedReview(62, DEFAULT_CONFIG, cwd, {}, runner([]).deps)).rejects.toThrow(/cannot map/);
  });
});
