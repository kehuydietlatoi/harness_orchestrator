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
import {
  formatReviewPrompt, listChangedFiles, MAX_DIFF_CHARS, parseVerdict, runAutomatedReview, type ReviewRunDeps,
} from "../src/board/review-run.js";
import { checkMergeGate } from "../src/board/review.js";

const head = "a".repeat(40);
const issue = { number: 38, title: "task", body: "do the thing", state: "OPEN", labels: ["agent:claude"], assignees: [] };
const pr = { number: 62, title: "task", body: "Closes #38", state: "OPEN", headSha: head, headRefName: "task/38-task", htmlUrl: "" };
const approveText = 'Looks good.\n```json\n{"decision":"approve","notes":"meets criteria"}\n```';
const changesText = '```json\n{"decision":"request-changes","notes":"add a test for the empty case"}\n```';
const limitRaw =
  '{"type":"turn.failed","error":{"message":"You hit your usage limit. try again at 11:59 PM."}}';

function runner(results: Array<{ code?: number; text?: string; raw?: string; timedOut?: boolean }>) {
  const calls: Array<{ reviewer: string; prompt: string; runCwd: string; timeoutMs: number }> = [];
  const checkouts: Array<{ path: string; released: boolean }> = [];
  const fn: ReviewRunDeps["runner"] = async (args) => {
    calls.push({ reviewer: args.reviewer, prompt: args.prompt, runCwd: args.runCwd, timeoutMs: args.timeoutMs });
    const r = results[calls.length - 1] ?? {};
    return { code: r.code ?? 0, timedOut: r.timedOut ?? false, text: r.text ?? "", raw: r.raw ?? "" };
  };
  const checkout: ReviewRunDeps["checkout"] = async (p) => {
    const c = { path: `/checkout/${p.headSha.slice(0, 8)}/${checkouts.length}`, released: false };
    checkouts.push(c);
    return { path: c.path, release: async () => { c.released = true; } };
  };
  const staged: Array<{ checkoutPath: string; prNumber: number; diff: string }> = [];
  const stageDiff: ReviewRunDeps["stageDiff"] = (checkoutPath, prNumber, diff) => {
    staged.push({ checkoutPath, prNumber, diff });
    return { relativePath: `.orch-review/pr-${prNumber}.diff`, absolutePath: `${checkoutPath}/.orch-review/pr-${prNumber}.diff` };
  };
  return { deps: { runner: fn, checkout, stageDiff, now: () => new Date() } satisfies ReviewRunDeps, calls, checkouts, staged };
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

/** A small, ordinary diff. */
const SMALL_DIFF = [
  "diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1 +1 @@", "-const old = 0;", "+const added = 1;",
  "diff --git a/src/gone.ts b/src/gone.ts", "deleted file mode 100644", "--- a/src/gone.ts", "+++ /dev/null", "@@ -1 +0,0 @@", "-export const gone = 1;",
].join("\n");

/** A diff far beyond the old 120k cutoff whose LAST file is a deletion: reading the checkout cannot reveal it. */
const BIG_DIFF = [
  "diff --git a/src/big.ts b/src/big.ts", "--- a/src/big.ts", "+++ b/src/big.ts", "@@ -1 +1,6000 @@",
  ...Array.from({ length: 6000 }, (_, i) => `+const line${i} = ${i}; // padding to push the diff well past the old cutoff`),
  "diff --git a/src/removed-late.ts b/src/removed-late.ts", "deleted file mode 100644", "--- a/src/removed-late.ts", "+++ /dev/null",
  "@@ -1,2 +0,0 @@", "-export const removedLate = 1;", "-export const alsoRemoved = 2;",
].join("\n");

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

  it("tells the reviewer to do the whole review itself instead of delegating to sub-agents", () => {
    const prompt = formatReviewPrompt(base);
    expect(prompt).toContain("Do the whole review yourself, in this session");
    expect(prompt).toContain("Do NOT spawn, message, or wait for other agents or sub-agents");
  });

  it("tells a self-reviewer to stay independent", () => {
    expect(formatReviewPrompt({ ...base, reviewer: "claude", mode: "self" })).toContain("fresh, independent session");
  });

  it("inlines a small diff in full and lists the files it changes", () => {
    const prompt = formatReviewPrompt({ ...base, diff: SMALL_DIFF });
    expect(prompt).toContain("+const added = 1;");
    expect(prompt).toContain('<changed-files count="2">');
    expect(prompt).toContain("- src/a.ts (modified, +1 -1)");
    expect(prompt).toContain("- src/gone.ts (deleted, +0 -1)");
    expect(prompt).not.toContain("too large to inline");
  });

  it("refuses to build a prompt that would truncate an oversized diff", () => {
    expect(() => formatReviewPrompt({ ...base, diff: BIG_DIFF })).toThrow(/must be staged as a file; refusing to truncate it/);
  });

  it("points an oversized diff at the staged file instead of inlining part of it", () => {
    const prompt = formatReviewPrompt({
      ...base, diff: BIG_DIFF, artifact: { relativePath: ".orch-review/pr-62.diff", absolutePath: "/co/.orch-review/pr-62.diff" },
    });

    expect(prompt).toContain(".orch-review/pr-62.diff");
    expect(prompt).toContain("/co/.orch-review/pr-62.diff");
    expect(prompt).toContain("Read ALL of it");
    expect(prompt).toContain("request-changes and say exactly what you did not review");
    expect(prompt).not.toContain("const line5999"); // none of the diff body is inlined, so none of it is silently cut off
    expect(prompt.length).toBeLessThan(MAX_DIFF_CHARS / 4);
    // The file that sits entirely beyond the old cutoff - and cannot be recovered by reading the checkout - is listed.
    expect(prompt).toContain("- src/removed-late.ts (deleted, +0 -2)");
  });
});

describe("listChangedFiles", () => {
  it("reports added, deleted, renamed, modified and binary files with line counts", () => {
    const diff = [
      "diff --git a/src/new.ts b/src/new.ts", "new file mode 100644", "--- /dev/null", "+++ b/src/new.ts", "@@ -0,0 +2 @@", "+one", "+two",
      "diff --git a/src/old.ts b/src/old.ts", "deleted file mode 100644", "--- a/src/old.ts", "+++ /dev/null", "@@ -1,3 +0,0 @@", "-a", "-b", "-c",
      "diff --git a/src/before.ts b/src/after.ts", "similarity index 90%", "rename from src/before.ts", "rename to src/after.ts", "@@ -1 +1 @@", "-x", "+y",
      "diff --git a/src/mod.ts b/src/mod.ts", "--- a/src/mod.ts", "+++ b/src/mod.ts", "@@ -1,2 +1,2 @@", " keep", "-old", "+new",
      "diff --git a/img/logo.png b/img/logo.png", "Binary files a/img/logo.png and b/img/logo.png differ",
    ].join("\n");

    expect(listChangedFiles(diff)).toEqual([
      { path: "src/new.ts", status: "added", binary: false, additions: 2, deletions: 0 },
      { path: "src/old.ts", status: "deleted", binary: false, additions: 0, deletions: 3 },
      { path: "src/after.ts", status: "renamed", from: "src/before.ts", binary: false, additions: 1, deletions: 1 },
      { path: "src/mod.ts", status: "modified", binary: false, additions: 1, deletions: 1 },
      { path: "img/logo.png", status: "modified", binary: true, additions: 0, deletions: 0 },
    ]);
  });

  it("does not count the +++/--- headers, and handles paths with spaces", () => {
    const diff = ["diff --git a/my file.ts b/my file.ts", "--- a/my file.ts", "+++ b/my file.ts", "@@ -1 +1 @@", "-a", "+b"].join("\n");
    expect(listChangedFiles(diff)).toEqual([{ path: "my file.ts", status: "modified", binary: false, additions: 1, deletions: 1 }]);
  });

  it("copes with empty and malformed input", () => {
    expect(listChangedFiles("")).toEqual([]);
    expect(listChangedFiles("diff --git a b")).toEqual([]);
    expect(listChangedFiles("not a diff at all\n+ looks like an addition")).toEqual([]);
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

  describe("exact-head checkout (the verdict is recorded against the PR SHA)", () => {
    it("runs the reviewer in a checkout of the PR head, not in the repository or the author worktree", async () => {
      const { deps, calls, checkouts } = runner([{ text: approveText }]);
      await runAutomatedReview(62, DEFAULT_CONFIG, cwd, {}, deps);

      expect(calls[0].runCwd).toBe(checkouts[0].path);
      expect(calls[0].runCwd).toContain(head.slice(0, 8));
      expect(calls[0].runCwd).not.toBe(cwd);
    });

    it("removes the checkout after a normal review", async () => {
      const { deps, checkouts } = runner([{ text: approveText }]);
      await runAutomatedReview(62, DEFAULT_CONFIG, cwd, {}, deps);
      expect(checkouts).toHaveLength(1);
      expect(checkouts[0].released).toBe(true);
    });

    it("removes the checkout even when the reviewer run blows up", async () => {
      const { deps, checkouts } = runner([]);
      deps.runner = async () => { throw new Error("harness exploded"); };

      await expect(runAutomatedReview(62, DEFAULT_CONFIG, cwd, {}, deps)).rejects.toThrow("harness exploded");
      expect(checkouts[0].released).toBe(true);
      expect(gh.recordPrReview).not.toHaveBeenCalled();
    });

    it("uses a fresh checkout for each attempt when falling back to a self-review", async () => {
      const { deps, calls, checkouts } = runner([{ code: 1, raw: limitRaw }, { text: approveText }]);
      await runAutomatedReview(62, DEFAULT_CONFIG, cwd, {}, deps);

      expect(checkouts).toHaveLength(2);
      expect(calls.map((c) => c.runCwd)).toEqual(checkouts.map((c) => c.path));
      expect(checkouts.every((c) => c.released)).toBe(true);
    });

    it("fails closed when no exact-head checkout can be provided: no review, nothing recorded", async () => {
      const { deps, calls } = runner([{ text: approveText }]);
      deps.checkout = async () => { throw new Error("could not check out PR #62 head aaaaaaaa"); };

      await expect(runAutomatedReview(62, DEFAULT_CONFIG, cwd, {}, deps)).rejects.toThrow("could not check out PR #62");
      expect(calls).toHaveLength(0);
      expect(gh.recordPrReview).not.toHaveBeenCalled();
      expect(gh.editIssue).not.toHaveBeenCalled();
    });

    it("asks for the head the PR had when the review began", async () => {
      const seen: string[] = [];
      const { deps } = runner([{ text: approveText }]);
      const inner = deps.checkout;
      deps.checkout = async (p) => { seen.push(p.headSha); return inner(p); };

      await runAutomatedReview(62, DEFAULT_CONFIG, cwd, {}, deps);
      expect(seen).toEqual([head]);
    });
  });

  it("gives the reviewer its own timeout, not the (much longer) task timeout", async () => {
    const cfg: OrchConfig = { ...DEFAULT_CONFIG, reviewTimeoutMs: 123_456, taskTimeoutMs: 9_999_999 };
    const { deps, calls } = runner([{ text: approveText }]);

    await runAutomatedReview(62, cfg, cwd, {}, deps);

    expect(calls[0].timeoutMs).toBe(123_456);
  });

  it("reports a timed-out review as a failure and records nothing, even if the harness later answered", async () => {
    const { deps } = runner([{ code: 124, timedOut: true, text: approveText }]);

    await expect(runAutomatedReview(62, DEFAULT_CONFIG, cwd, {}, deps)).rejects.toThrow("timed out");
    expect(gh.recordPrReview).not.toHaveBeenCalled();
  });

  describe("the reviewer is never given a partial diff", () => {
    it("inlines a small diff and stages nothing", async () => {
      vi.mocked(gh.prDiff).mockResolvedValue(SMALL_DIFF);
      const { deps, calls, staged } = runner([{ text: approveText }]);

      await runAutomatedReview(62, DEFAULT_CONFIG, cwd, {}, deps);

      expect(staged).toEqual([]);
      expect(calls[0].prompt).toContain("+const added = 1;");
    });

    it("stages an oversized diff IN FULL and lists a deleted file that sits beyond the old cutoff", async () => {
      expect(BIG_DIFF.length).toBeGreaterThan(MAX_DIFF_CHARS * 1.2);
      expect(BIG_DIFF.indexOf("src/removed-late.ts")).toBeGreaterThan(MAX_DIFF_CHARS); // invisible under the old truncation
      vi.mocked(gh.prDiff).mockResolvedValue(BIG_DIFF);
      const { deps, calls, staged, checkouts } = runner([{ text: approveText }]);

      const out = await runAutomatedReview(62, DEFAULT_CONFIG, cwd, {}, deps);

      expect(staged).toHaveLength(1);
      expect(staged[0].diff).toBe(BIG_DIFF); // the complete diff, byte for byte
      expect(staged[0].checkoutPath).toBe(checkouts[0].path); // inside the exact-head checkout the reviewer runs in
      expect(calls[0].prompt).toContain(".orch-review/pr-62.diff");
      expect(calls[0].prompt).toContain("- src/removed-late.ts (deleted, +0 -2)");
      expect(calls[0].prompt).not.toContain("const line5999");
      expect(out.decision).toBe("approve");
    });

    it("fails closed when an oversized diff cannot be staged: no review, nothing recorded, checkout released", async () => {
      vi.mocked(gh.prDiff).mockResolvedValue(BIG_DIFF);
      const { deps, calls, checkouts } = runner([{ text: approveText }]);
      deps.stageDiff = () => { throw new Error("disk full"); };

      await expect(runAutomatedReview(62, DEFAULT_CONFIG, cwd, {}, deps)).rejects.toThrow("disk full");

      expect(calls).toHaveLength(0);
      expect(gh.recordPrReview).not.toHaveBeenCalled();
      expect(checkouts[0].released).toBe(true);
    });

    it("fails closed when the diff cannot be fetched, before any checkout or reviewer run", async () => {
      vi.mocked(gh.prDiff).mockRejectedValue(new Error("could not fetch the diff of PR #62: HTTP 406 diff too large"));
      const { deps, calls, checkouts } = runner([{ text: approveText }]);

      await expect(runAutomatedReview(62, DEFAULT_CONFIG, cwd, {}, deps)).rejects.toThrow("could not fetch the diff of PR #62");

      expect(calls).toHaveLength(0);
      expect(checkouts).toHaveLength(0);
      expect(gh.recordPrReview).not.toHaveBeenCalled();
    });

    it("refuses to review an empty diff rather than approving nothing", async () => {
      vi.mocked(gh.prDiff).mockResolvedValue("  \n");
      const { deps, calls } = runner([{ text: approveText }]);

      await expect(runAutomatedReview(62, DEFAULT_CONFIG, cwd, {}, deps)).rejects.toThrow("nothing to review");
      expect(calls).toHaveLength(0);
    });

    it("asks for the diff strictly, and only once even when it falls back to another reviewer", async () => {
      const { deps } = runner([{ code: 1, raw: limitRaw }, { text: approveText }]);
      await runAutomatedReview(62, DEFAULT_CONFIG, cwd, {}, deps);

      expect(gh.prDiff).toHaveBeenCalledTimes(1);
      expect(gh.prDiff).toHaveBeenCalledWith(62, { cwd, strict: true });
    });
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
