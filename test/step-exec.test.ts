import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";

vi.mock("../src/github/github.js", () => ({
  editIssue: vi.fn(), commentOnPr: vi.fn(), failingChecks: vi.fn(), getPr: vi.fn(), getIssue: vi.fn(),
  prDiff: vi.fn(), listPrReviews: vi.fn(), recordPrReview: vi.fn(), prChecksPass: vi.fn(), mergePr: vi.fn(),
}));
vi.mock("../src/git/git.js", () => ({ resolveBaseBranch: vi.fn() }));
vi.mock("../src/git/worktree.js", () => ({ observeWorktree: vi.fn(), worktreePath: vi.fn(), removeWorktree: vi.fn() }));
vi.mock("../src/git/lock.js", () => ({ release: vi.fn() }));
vi.mock("../src/tasks/runner.js", () => ({
  recordRun: vi.fn(),
  resolveTaskModel: () => ({ model: "m", effort: "medium" }),
}));
vi.mock("../src/board/review.js", () => ({ merge: vi.fn(), approve: vi.fn(), requestChanges: vi.fn(), prIssueNumber: () => 38 }));
vi.mock("../src/board/review-run.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/board/review-run.js")>()),
  runAutomatedReview: vi.fn(),
}));

import { availabilityPath, markUnavailable, unavailableUntil } from "../src/board/availability.js";
import { merge } from "../src/board/review.js";
import { NoReviewerError, runAutomatedReview } from "../src/board/review-run.js";
import { resolveBaseBranch } from "../src/git/git.js";
import { observeWorktree } from "../src/git/worktree.js";
import * as gh from "../src/github/github.js";
import type { TaskObservation } from "../src/tasks/observe.js";
import { recordRun } from "../src/tasks/runner.js";
import { readSession, writeSession } from "../src/tasks/sessions.js";
import {
  executeEscalate, executeFix, executeMerge, executeResolveConflict, executeReview, pickResolver,
  type StepEnv,
} from "../src/tasks/step-exec.js";
import type { StepFacts } from "../src/tasks/steps.js";

const HEAD = "a".repeat(40);
const NEW_HEAD = "b".repeat(40);
const issue = { number: 38, title: "Add the thing", body: "spec text", state: "OPEN", labels: ["agent:codex"], assignees: [] };
const pr = { number: 62, title: "t", body: "Closes #38", state: "OPEN", headSha: HEAD, headRefName: "task/38-add-the-thing", htmlUrl: "" };
const LIMIT_LOG = '{"type":"turn.failed","error":{"message":"You hit your usage limit. try again at 11:59 PM."}}\n';

function obs(over: { author?: string; rounds?: number; feedback?: string | null } = {}): TaskObservation {
  const facts: StepFacts = {
    attention: false,
    pr: { number: 62, head: HEAD, checks: "pass", mergeable: "clean" },
    review: { approved: false, changesRequested: true },
    rounds: over.rounds ?? 0,
    maxRounds: 3,
    requireHumanMerge: false,
  };
  return {
    issue, author: over.author ?? "codex", pr, reviews: [], facts, step: { kind: "fix", reason: "review" },
    feedback: over.feedback === undefined ? "add a test for the empty case" : over.feedback,
  };
}

/** A scripted harness + git: each call records its inputs and returns the next scripted result. */
function fakeEnv(opts: {
  runs?: Array<{ ok?: boolean; code?: number; sessionId?: string; log?: string; timedOut?: boolean }>;
  head?: string;
  dirty?: boolean;
  pushCode?: number;
  /** Whether the base branch is an ancestor of HEAD (conflict resolution check). */
  ancestor?: boolean;
  /** Whether the worktree HEAD contains the PR head (the pre-flight worktree check). */
  headContained?: boolean | boolean[];
  /** `git rev-parse` fails (inspecting the result of a completed run throws). */
  revParseFails?: boolean;
}) {
  const agentCalls: Array<Parameters<StepEnv["runAgent"]>[0]> = [];
  const gitCalls: string[][] = [];
  let headChecks = 0;
  const env: StepEnv = {
    runAgent: async (ctx) => {
      agentCalls.push(ctx);
      const r = opts.runs?.[agentCalls.length - 1] ?? { ok: true };
      // Append, exactly like spawnLogged: a retry in the same round shares the same log file.
      if (r.log && ctx.logFile) appendFileSync(ctx.logFile, r.log, "utf8");
      return { ok: r.ok ?? true, code: r.code ?? (r.ok === false ? 1 : 0), durationMs: 5, timedOut: r.timedOut ?? false, sessionId: r.sessionId };
    },
    git: async (args) => {
      gitCalls.push(args);
      const ok = { code: 0, stderr: "" };
      if (args[0] === "rev-parse") {
        if (opts.revParseFails) return { code: 128, stdout: "", stderr: "fatal: not a git repository" };
        return { ...ok, stdout: `${opts.head ?? NEW_HEAD}\n` };
      }
      if (args[0] === "status") return { ...ok, stdout: opts.dirty ? " M file.ts\n" : "" };
      if (args[0] === "push") return { code: opts.pushCode ?? 0, stdout: "", stderr: opts.pushCode ? "rejected" : "" };
      if (args[0] === "merge-base") {
        // `headContained` may be a sequence: [true, false] = fine before the run, lost by the time we push.
        const seq = Array.isArray(opts.headContained) ? opts.headContained : [opts.headContained !== false];
        const intact = args[2] === HEAD ? seq[Math.min(headChecks++, seq.length - 1)] : opts.ancestor !== false;
        return { code: intact ? 0 : 1, stdout: "", stderr: "" };
      }
      return { ...ok, stdout: "" };
    },
  };
  return { env, agentCalls, gitCalls };
}

describe("step executors", () => {
  let cwd = "";
  let wt = "";
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "orch-step-"));
    wt = mkdtempSync(join(tmpdir(), "orch-step-wt-"));
    vi.resetAllMocks();
    vi.mocked(observeWorktree).mockResolvedValue({
      outcome: "usable", worktree: { path: wt, branch: "task/38-add-the-thing" },
    });
    vi.mocked(resolveBaseBranch).mockResolvedValue({ name: "main", ref: "refs/heads/main" });
    vi.mocked(gh.failingChecks).mockResolvedValue(["build", "lint"]);
  });
  afterEach(() => {
    rmSync(dirname(availabilityPath(cwd)), { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    rmSync(wt, { recursive: true, force: true });
    rmSync(join(cwd, "logs"), { recursive: true, force: true });
  });

  describe("executeFix", () => {
    it("resumes the author's own session, pushes without force, and requeues the review", async () => {
      writeSession(38, { agent: "codex", sessionId: "old-thread" }, cwd);
      const { env, agentCalls, gitCalls } = fakeEnv({ runs: [{ ok: true, sessionId: "old-thread" }] });

      const result = await executeFix(obs(), "review", DEFAULT_CONFIG, cwd, env);

      expect(result).toEqual({ signal: "fix.pushed", detail: "round 1 (review)" });
      expect(agentCalls).toHaveLength(1);
      expect(agentCalls[0]).toMatchObject({ agent: "codex", worktree: wt, resumeSession: "old-thread" });
      expect(agentCalls[0].prompt).toContain("earlier in this conversation");
      expect(agentCalls[0].prompt).toContain("add a test for the empty case");
      const push = gitCalls.find((a) => a[0] === "push") as string[];
      expect(push).toEqual(["push", "origin", "HEAD:refs/heads/task/38-add-the-thing"]);
      expect(push).not.toContain("--force");
      expect(gh.editIssue).toHaveBeenCalledWith(38, expect.objectContaining({
        addLabels: ["status:in-review", "review:needed"], removeLabels: ["status:in-progress"],
      }));
      expect(recordRun).toHaveBeenCalledWith(38, "codex", expect.anything(), "fix-pushed", expect.any(Number),
        expect.any(String), cwd, DEFAULT_CONFIG, { phase: "fix", round: 1, since: expect.any(Number) });
    });

    it("clears stale approval projections when the new head is requeued for review", async () => {
      const { env } = fakeEnv({});
      const stale = { ...obs(), issue: { ...issue, labels: ["agent:codex", "reviewed-by:claude"] } };
      await executeFix(stale, "review", DEFAULT_CONFIG, cwd, env);
      expect(gh.editIssue).toHaveBeenCalledWith(38, expect.objectContaining({
        removeLabels: ["status:in-progress", "reviewed-by:claude"],
      }));
    });

    it("cold-starts with the spec and diff instructions when no session is on record", async () => {
      const { env, agentCalls } = fakeEnv({ runs: [{ ok: true, sessionId: "fresh" }] });
      await executeFix(obs(), "review", DEFAULT_CONFIG, cwd, env);

      expect(agentCalls[0].resumeSession).toBeUndefined();
      expect(agentCalls[0].prompt).toContain("memory is gone");
      expect(agentCalls[0].prompt).toContain("git diff main...HEAD");
      expect(agentCalls[0].prompt).toContain("spec text");
      expect(readSession(38, cwd)?.sessionId).toBe("fresh");
    });

    it("ignores a recorded session that belongs to a different harness", async () => {
      writeSession(38, { agent: "claude", sessionId: "claude-thread" }, cwd);
      const { env, agentCalls } = fakeEnv({});
      await executeFix(obs({ author: "codex" }), "review", DEFAULT_CONFIG, cwd, env);
      expect(agentCalls[0].resumeSession).toBeUndefined();
    });

    it("falls back to a fresh session when the harness refuses to resume", async () => {
      writeSession(38, { agent: "codex", sessionId: "expired" }, cwd);
      const { env, agentCalls } = fakeEnv({ runs: [{ ok: false, code: 1 }, { ok: true, sessionId: "new-thread" }] });

      const result = await executeFix(obs(), "review", DEFAULT_CONFIG, cwd, env);

      expect(result.signal).toBe("fix.pushed");
      expect(agentCalls).toHaveLength(2);
      expect(agentCalls[0].resumeSession).toBe("expired");
      expect(agentCalls[1].resumeSession).toBeUndefined();
      expect(agentCalls[1].prompt).toContain("memory is gone");
      expect(readSession(38, cwd)?.sessionId).toBe("new-thread");
      // Both attempts cost something, and each is accounted for on its own log.
      expect(vi.mocked(recordRun).mock.calls.map((c) => c[3])).toEqual(["fix-resume-failed", "fix-pushed"]);
      expect(String(vi.mocked(recordRun).mock.calls[0][5])).toContain("fix1.jsonl");
      expect(String(vi.mocked(recordRun).mock.calls[1][5])).toContain("fix1-cold.jsonl");
    });

    it("names the failing checks for a CI fix", async () => {
      const { env, agentCalls } = fakeEnv({});
      const result = await executeFix(obs({ feedback: null }), "ci", DEFAULT_CONFIG, cwd, env);
      expect(result.detail).toBe("round 1 (ci)");
      expect(agentCalls[0].prompt).toContain("Failing checks: build, lint");
    });

    it("pauses the author instead of failing when its run hits a usage limit", async () => {
      const { env } = fakeEnv({ runs: [{ ok: false, code: 1, log: LIMIT_LOG }] });
      const result = await executeFix(obs(), "review", DEFAULT_CONFIG, cwd, env);

      expect(result.signal).toBe("agent.unavailable");
      expect(unavailableUntil("codex", cwd)).not.toBeNull();
      expect(gh.editIssue).not.toHaveBeenCalled();
    });

    it("does not retry cold when the first failure was a usage limit", async () => {
      writeSession(38, { agent: "codex", sessionId: "s" }, cwd);
      const { env, agentCalls } = fakeEnv({ runs: [{ ok: false, code: 1, log: LIMIT_LOG }] });
      await executeFix(obs(), "review", DEFAULT_CONFIG, cwd, env);
      expect(agentCalls).toHaveLength(1);
    });

    it("does not start when the author is already paused", async () => {
      markUnavailable("codex", { resetAt: null, reason: "limit" }, cwd);
      const { env, agentCalls } = fakeEnv({});
      expect((await executeFix(obs(), "review", DEFAULT_CONFIG, cwd, env)).signal).toBe("agent.unavailable");
      expect(agentCalls).toHaveLength(0);
    });

    it("fails without pushing when the agent made no new commits", async () => {
      const { env, gitCalls } = fakeEnv({ head: HEAD });
      const result = await executeFix(obs(), "review", DEFAULT_CONFIG, cwd, env);
      expect(result).toEqual({ signal: "step.failed", detail: "the agent made no new commits" });
      expect(gitCalls.some((a) => a[0] === "push")).toBe(false);
      expect(recordRun).toHaveBeenCalledWith(38, "codex", expect.anything(), "fix-failed", expect.any(Number),
        expect.any(String), cwd, DEFAULT_CONFIG, { phase: "fix", round: 1, since: expect.any(Number) });
    });

    it("fails without pushing when uncommitted changes were left behind", async () => {
      const { env, gitCalls } = fakeEnv({ dirty: true });
      const result = await executeFix(obs(), "review", DEFAULT_CONFIG, cwd, env);
      expect(result.signal).toBe("step.failed");
      expect(result.detail).toContain("uncommitted");
      expect(gitCalls.some((a) => a[0] === "push")).toBe(false);
    });

    it("does not touch labels when the push is rejected", async () => {
      const { env } = fakeEnv({ pushCode: 1 });
      const result = await executeFix(obs(), "review", DEFAULT_CONFIG, cwd, env);
      expect(result).toMatchObject({ signal: "step.failed", detail: expect.stringContaining("git push failed") });
      expect(gh.editIssue).not.toHaveBeenCalled();
    });

    it("fails when the task worktree is gone", async () => {
      vi.mocked(observeWorktree).mockResolvedValue({ outcome: "absent" });
      const { env, agentCalls } = fakeEnv({});
      const result = await executeFix(obs(), "review", DEFAULT_CONFIG, cwd, env);
      expect(result.detail).toContain("is missing");
      expect(result.detail).toContain("orch repair 38");
      expect(agentCalls).toHaveLength(0);
    });

    describe("worktree verification (a directory existing is not enough)", () => {
      it.each([
        ["detached or unregistered", { outcome: "conflict" as const, detail: "worktree path is attached to 'detached HEAD', expected 'task/38-add-the-thing'" }],
        ["unreadable", { outcome: "error" as const, detail: "git worktree list failed" }],
      ])("refuses a %s worktree before any agent runs or anything is pushed", async (_name, seen) => {
        vi.mocked(observeWorktree).mockResolvedValue(seen);
        const { env, agentCalls, gitCalls } = fakeEnv({});

        const result = await executeFix(obs(), "review", DEFAULT_CONFIG, cwd, env);

        expect(result.signal).toBe("step.failed");
        expect(result.detail).toContain("not usable");
        expect(result.detail).toContain(seen.detail);
        expect(agentCalls).toHaveLength(0);
        expect(gitCalls.some((a) => a[0] === "push")).toBe(false);
      });

      it("refuses a worktree on a different branch than the PR", async () => {
        vi.mocked(observeWorktree).mockResolvedValue({
          outcome: "usable", worktree: { path: wt, branch: "task/99-something-else" },
        });
        const { env, agentCalls, gitCalls } = fakeEnv({});

        const result = await executeFix(obs(), "review", DEFAULT_CONFIG, cwd, env);

        expect(result.detail).toContain("is on 'task/99-something-else' but PR #62 is 'task/38-add-the-thing'");
        expect(agentCalls).toHaveLength(0);
        expect(gitCalls.some((a) => a[0] === "push")).toBe(false);
      });

      it("refuses a worktree whose history does not contain the PR head", async () => {
        const { env, agentCalls, gitCalls } = fakeEnv({ headContained: false });

        const result = await executeFix(obs(), "review", DEFAULT_CONFIG, cwd, env);

        expect(result.detail).toContain(`does not contain PR head ${HEAD.slice(0, 8)}`);
        expect(agentCalls).toHaveLength(0);
        expect(gitCalls.some((a) => a[0] === "push")).toBe(false);
      });

      it("fetches the PR branch first so a head pushed from elsewhere is known locally", async () => {
        const { env, gitCalls } = fakeEnv({});
        await executeFix(obs(), "review", DEFAULT_CONFIG, cwd, env);
        expect(gitCalls[0]).toEqual(["fetch", "origin", "task/38-add-the-thing"]);
        expect(gitCalls[1]).toEqual(["merge-base", "--is-ancestor", HEAD, "HEAD"]);
      });

      it("applies the same checks before resolving a conflict", async () => {
        vi.mocked(observeWorktree).mockResolvedValue({
          outcome: "usable", worktree: { path: wt, branch: "task/99-something-else" },
        });
        const { env, agentCalls, gitCalls } = fakeEnv({});

        const result = await executeResolveConflict(obs(), DEFAULT_CONFIG, cwd, env);

        expect(result.signal).toBe("step.failed");
        expect(result.detail).toContain("refusing to edit or push");
        expect(agentCalls).toHaveLength(0);
        expect(gitCalls.some((a) => a[0] === "push")).toBe(false);

        const second = fakeEnv({ headContained: false });
        vi.mocked(observeWorktree).mockResolvedValue({
          outcome: "usable", worktree: { path: wt, branch: "task/38-add-the-thing" },
        });
        expect((await executeResolveConflict(obs(), DEFAULT_CONFIG, cwd, second.env)).detail).toContain("does not contain PR head");
        expect(second.agentCalls).toHaveLength(0);
      });
    });

    it("reports a generic crash as a failure, not an outage", async () => {
      const { env } = fakeEnv({ runs: [{ ok: false, code: 2 }, { ok: false, code: 2 }] });
      const result = await executeFix(obs(), "review", DEFAULT_CONFIG, cwd, env);
      expect(result).toEqual({ signal: "step.failed", detail: "'codex' exited 2" });
    });
  });

  describe("a retry in the same round shares its log file with the earlier attempt", () => {
    const clearCooldown = () => rmSync(availabilityPath(cwd), { force: true });

    it("does not re-pause the harness for a new, non-quota failure after the cooldown expired (fix)", async () => {
      writeSession(38, { agent: "codex", sessionId: "thread" }, cwd);
      const first = fakeEnv({ runs: [{ ok: false, code: 1, log: LIMIT_LOG }] });
      expect((await executeFix(obs(), "review", DEFAULT_CONFIG, cwd, first.env)).signal).toBe("agent.unavailable");
      expect(unavailableUntil("codex", cwd)).not.toBeNull();

      clearCooldown(); // the limit has reset; the very same round is retried
      const second = fakeEnv({ runs: [{ ok: false, code: 1 }, { ok: false, code: 2 }] });
      const result = await executeFix(obs(), "review", DEFAULT_CONFIG, cwd, second.env);

      expect(result).toEqual({ signal: "step.failed", detail: "'codex' exited 2" }); // counts toward escalation
      expect(unavailableUntil("codex", cwd)).toBeNull();
      expect(second.agentCalls).toHaveLength(2); // the cold-session fallback was NOT suppressed
      expect(second.agentCalls[1].resumeSession).toBeUndefined();
    });

    it("reads telemetry from this run's own range: usage followed by a retry without usage", async () => {
      const first = fakeEnv({ runs: [{ ok: false, code: 1, log: LIMIT_LOG }] });
      await executeFix(obs(), "review", DEFAULT_CONFIG, cwd, first.env);
      const sinceFirst = vi.mocked(recordRun).mock.calls.at(-1)?.[8] as { since: number };
      expect(sinceFirst.since).toBe(0); // the first attempt started on an empty log
      clearCooldown();

      const second = fakeEnv({ runs: [{ ok: true }] }); // the retry reports no usage of its own
      await executeFix(obs(), "review", DEFAULT_CONFIG, cwd, second.env);

      const meta = vi.mocked(recordRun).mock.calls.at(-1)?.[8] as { since: number };
      expect(meta.since).toBe(Buffer.byteLength(LIMIT_LOG)); // everything the first attempt wrote is excluded
    });

    it("still pauses the harness when the retry itself hits a usage limit", async () => {
      const first = fakeEnv({ runs: [{ ok: false, code: 1, log: LIMIT_LOG }] });
      await executeFix(obs(), "review", DEFAULT_CONFIG, cwd, first.env);
      clearCooldown();

      const second = fakeEnv({ runs: [{ ok: false, code: 1, log: LIMIT_LOG }] });
      expect((await executeFix(obs(), "review", DEFAULT_CONFIG, cwd, second.env)).signal).toBe("agent.unavailable");
      expect(unavailableUntil("codex", cwd)).not.toBeNull();
    });

    it("does not re-pause the harness for a new, non-quota failure after the cooldown expired (conflict)", async () => {
      const first = fakeEnv({ runs: [{ ok: false, code: 1, log: LIMIT_LOG }] });
      expect((await executeResolveConflict(obs(), DEFAULT_CONFIG, cwd, first.env)).signal).toBe("agent.unavailable");
      clearCooldown();

      const second = fakeEnv({ runs: [{ ok: false, code: 2 }] });
      const result = await executeResolveConflict(obs(), DEFAULT_CONFIG, cwd, second.env);

      expect(result).toEqual({ signal: "step.failed", detail: "'claude' exited 2" });
      expect(unavailableUntil("claude", cwd)).toBeNull();
    });
  });

  describe("the worktree is verified again immediately before publishing", () => {
    const right = { outcome: "usable" as const, worktree: { path: "", branch: "task/38-add-the-thing" } };
    const onBranch = (branch: string) => ({ outcome: "usable" as const, worktree: { path: wt, branch } });

    it("refuses to push when the harness switched the worktree to another branch while it ran", async () => {
      vi.mocked(observeWorktree)
        .mockResolvedValueOnce(onBranch("task/38-add-the-thing")) // before the run: correct
        .mockResolvedValueOnce(onBranch("task/99-other")); // by the time it finished: switched
      const { env, agentCalls, gitCalls } = fakeEnv({});

      const result = await executeFix(obs(), "review", DEFAULT_CONFIG, cwd, env);

      expect(agentCalls).toHaveLength(1); // the run happened...
      expect(result.signal).toBe("step.failed");
      expect(result.detail).toContain("is on 'task/99-other'");
      expect(result.detail).toContain("checked again just before pushing");
      expect(gitCalls.some((a) => a[0] === "push")).toBe(false); // ...but nothing was published
      expect(gh.editIssue).not.toHaveBeenCalled();
      expect(recordRun).toHaveBeenCalledWith(38, "codex", expect.anything(), "fix-failed", expect.any(Number),
        expect.any(String), cwd, DEFAULT_CONFIG, { phase: "fix", round: 1, since: expect.any(Number) });
    });

    it("refuses to push when the worktree became detached or unregistered during the run", async () => {
      vi.mocked(observeWorktree)
        .mockResolvedValueOnce(onBranch("task/38-add-the-thing"))
        .mockResolvedValueOnce({ outcome: "conflict", detail: "worktree path is attached to 'detached HEAD'" });
      const { env, gitCalls } = fakeEnv({});

      const result = await executeFix(obs(), "review", DEFAULT_CONFIG, cwd, env);

      expect(result.detail).toContain("not usable");
      expect(result.detail).toContain("detached HEAD");
      expect(gitCalls.some((a) => a[0] === "push")).toBe(false);
    });

    it("refuses to push when the PR head is no longer part of the worktree history (history rewritten)", async () => {
      const { env, gitCalls } = fakeEnv({ headContained: [true, false] });

      const result = await executeFix(obs(), "review", DEFAULT_CONFIG, cwd, env);

      expect(result.detail).toContain(`does not contain PR head ${HEAD.slice(0, 8)}`);
      expect(gitCalls.some((a) => a[0] === "push")).toBe(false);
    });

    it("applies the same last-moment check to a conflict resolution", async () => {
      vi.mocked(observeWorktree)
        .mockResolvedValueOnce(onBranch("task/38-add-the-thing"))
        .mockResolvedValueOnce(onBranch("task/99-other"));
      const { env, agentCalls, gitCalls } = fakeEnv({});

      const result = await executeResolveConflict(obs(), DEFAULT_CONFIG, cwd, env);

      expect(agentCalls).toHaveLength(1);
      expect(result.signal).toBe("step.failed");
      expect(result.detail).toContain("checked again just before pushing");
      expect(gitCalls.some((a) => a[0] === "push")).toBe(false);
    });

    it("still pushes when the worktree is unchanged (the extra check is not a new way to fail)", async () => {
      vi.mocked(observeWorktree).mockResolvedValue(onBranch("task/38-add-the-thing")); // sticky: both checks pass
      const { env, gitCalls } = fakeEnv({});

      expect((await executeFix(obs(), "review", DEFAULT_CONFIG, cwd, env)).signal).toBe("fix.pushed");
      expect(gitCalls.some((a) => a[0] === "push")).toBe(true);
      expect(right.worktree.branch).toBe("task/38-add-the-thing");
    });
  });

  describe("the cold-session fallback after a failed resumed run", () => {
    const onBranch = (branch: string) => ({ outcome: "usable" as const, worktree: { path: wt, branch } });
    const resumable = () => writeSession(38, { agent: "codex", sessionId: "thread" }, cwd);

    it("does not start a second writable run when the first one left the worktree on another branch", async () => {
      resumable();
      vi.mocked(observeWorktree)
        .mockResolvedValueOnce(onBranch("task/38-add-the-thing")) // before the first run
        .mockResolvedValueOnce(onBranch("task/99-other")); // after it failed: it switched branches
      const { env, agentCalls, gitCalls } = fakeEnv({ runs: [{ ok: false, code: 1 }, { ok: true }] });

      const result = await executeFix(obs(), "review", DEFAULT_CONFIG, cwd, env);

      expect(agentCalls).toHaveLength(1); // no second agent run
      expect(result.signal).toBe("step.failed");
      expect(result.detail).toContain("is on 'task/99-other'");
      expect(result.detail).toContain("checked again just before pushing");
      expect(gitCalls.some((a) => a[0] === "push")).toBe(false);
      expect(gh.editIssue).not.toHaveBeenCalled();
      // The failed resumed run still cost something and is recorded, once.
      expect(vi.mocked(recordRun).mock.calls.map((c) => c[3])).toEqual(["fix-resume-failed"]);
    });

    it("does not start a second writable run when the first one detached HEAD or lost registration", async () => {
      resumable();
      vi.mocked(observeWorktree)
        .mockResolvedValueOnce(onBranch("task/38-add-the-thing"))
        .mockResolvedValueOnce({ outcome: "conflict", detail: "worktree path is attached to 'detached HEAD'" });
      const { env, agentCalls } = fakeEnv({ runs: [{ ok: false, code: 1 }, { ok: true }] });

      const result = await executeFix(obs(), "review", DEFAULT_CONFIG, cwd, env);

      expect(agentCalls).toHaveLength(1);
      expect(result.detail).toContain("detached HEAD");
    });

    it("does not start a second writable run when the first one rewrote history", async () => {
      resumable();
      const { env, agentCalls } = fakeEnv({ runs: [{ ok: false, code: 1 }, { ok: true }], headContained: [true, false] });

      const result = await executeFix(obs(), "review", DEFAULT_CONFIG, cwd, env);

      expect(agentCalls).toHaveLength(1);
      expect(result.detail).toContain(`does not contain PR head ${HEAD.slice(0, 8)}`);
    });

    it("still falls back to a fresh session when the worktree is intact", async () => {
      resumable();
      const { env, agentCalls } = fakeEnv({ runs: [{ ok: false, code: 1 }, { ok: true, sessionId: "fresh" }] });

      const result = await executeFix(obs(), "review", DEFAULT_CONFIG, cwd, env);

      expect(result.signal).toBe("fix.pushed");
      expect(agentCalls).toHaveLength(2);
      expect(agentCalls[1].resumeSession).toBeUndefined();
    });
  });

  describe("after the push has happened", () => {
    it("keeps the pushed outcome and its round when the label update fails (fix)", async () => {
      vi.mocked(gh.editIssue).mockRejectedValue(new Error("labels down"));
      const { env, gitCalls } = fakeEnv({});

      const result = await executeFix(obs(), "review", DEFAULT_CONFIG, cwd, env);

      expect(gitCalls.some((a) => a[0] === "push")).toBe(true);
      expect(result.signal).toBe("fix.pushed"); // the round is spent: the head changed on GitHub
      expect(result.detail).toContain("round 1 (review)");
      expect(result.detail).toContain("labels not updated (labels down)");
      expect(result.detail).toContain("orch repair 38");
      expect(recordRun).toHaveBeenCalledWith(38, "codex", expect.anything(), "fix-pushed", expect.any(Number),
        expect.any(String), cwd, DEFAULT_CONFIG, { phase: "fix", round: 1, since: expect.any(Number) });
    });

    it("keeps the pushed outcome when the label update fails (conflict resolution)", async () => {
      vi.mocked(gh.editIssue).mockRejectedValue(new Error("labels down"));
      const { env } = fakeEnv({});

      const result = await executeResolveConflict(obs(), DEFAULT_CONFIG, cwd, env);

      expect(result.signal).toBe("conflict.resolved");
      expect(result.detail).toContain("labels not updated (labels down)");
      expect(recordRun).toHaveBeenCalledWith(38, "claude", expect.anything(), "resolve-pushed", expect.any(Number),
        expect.any(String), cwd, DEFAULT_CONFIG, { phase: "resolve-conflict", round: 1, since: expect.any(Number) });
    });

    it("counts that round: the pushed signal is what the budget is derived from", async () => {
      vi.mocked(gh.editIssue).mockRejectedValue(new Error("labels down"));
      const { env } = fakeEnv({});
      const { fixRoundsFor } = await import("../src/tasks/events.js");

      const result = await executeFix(obs(), "review", DEFAULT_CONFIG, cwd, env);

      const asEvent = { ts: "t", issue: 38, type: "step.finished", step: "fix", signal: result.signal };
      expect(fixRoundsFor([asEvent], 38)).toBe(1);
    });

    it("always records telemetry for a completed run, even when inspecting its result throws (fix)", async () => {
      const { env } = fakeEnv({ revParseFails: true });

      const result = await executeFix(obs(), "review", DEFAULT_CONFIG, cwd, env);

      expect(result.signal).toBe("step.failed");
      expect(result.detail).toContain("git rev-parse failed");
      expect(recordRun).toHaveBeenCalledWith(38, "codex", expect.anything(), "fix-failed", expect.any(Number),
        expect.any(String), cwd, DEFAULT_CONFIG, { phase: "fix", round: 1, since: expect.any(Number) });
    });

    it("always records telemetry for a completed run, even when inspecting its result throws (conflict)", async () => {
      const { env } = fakeEnv({ revParseFails: true });

      const result = await executeResolveConflict(obs(), DEFAULT_CONFIG, cwd, env);

      expect(result.signal).toBe("step.failed");
      expect(recordRun).toHaveBeenCalledWith(38, "claude", expect.anything(), "resolve-failed", expect.any(Number),
        expect.any(String), cwd, DEFAULT_CONFIG, { phase: "resolve-conflict", round: 1, since: expect.any(Number) });
    });
  });

  describe("pickResolver", () => {
    it("prefers claude, then the author, then nobody", () => {
      expect(pickResolver("codex", DEFAULT_CONFIG, cwd)).toBe("claude");
      markUnavailable("claude", { resetAt: null, reason: "x" }, cwd);
      expect(pickResolver("codex", DEFAULT_CONFIG, cwd)).toBe("codex");
      markUnavailable("codex", { resetAt: null, reason: "x" }, cwd);
      expect(pickResolver("codex", DEFAULT_CONFIG, cwd)).toBeNull();
    });
  });

  describe("executeResolveConflict", () => {
    it("fetches the base, has claude merge it, and pushes the result", async () => {
      const { env, agentCalls, gitCalls } = fakeEnv({});
      const result = await executeResolveConflict(obs(), DEFAULT_CONFIG, cwd, env);

      expect(result).toEqual({ signal: "conflict.resolved", detail: "resolved by 'claude'" });
      expect(gitCalls.find((a) => a[0] === "fetch" && a[2] === "main")).toEqual(["fetch", "origin", "main"]);
      expect(agentCalls[0].agent).toBe("claude");
      expect(agentCalls[0].prompt).toContain("git merge origin/main");
      expect(agentCalls[0].prompt).toContain("not a rebase");
      expect(gitCalls.some((a) => a[0] === "merge-base" && a.includes("origin/main"))).toBe(true);
      expect(gitCalls.some((a) => a[0] === "push")).toBe(true);
      expect(recordRun).toHaveBeenCalledWith(38, "claude", expect.anything(), "resolve-pushed", expect.any(Number),
        expect.any(String), cwd, DEFAULT_CONFIG, { phase: "resolve-conflict", round: 1, since: expect.any(Number) });
    });

    it("refuses to push a branch that still lacks the base", async () => {
      const { env, gitCalls } = fakeEnv({ ancestor: false });
      const result = await executeResolveConflict(obs(), DEFAULT_CONFIG, cwd, env);
      expect(result.detail).toContain("does not contain origin/main");
      expect(gitCalls.some((a) => a[0] === "push")).toBe(false);
    });

    it("waits when no harness can resolve the conflict", async () => {
      markUnavailable("claude", { resetAt: null, reason: "x" }, cwd);
      markUnavailable("codex", { resetAt: null, reason: "x" }, cwd);
      const { env, agentCalls } = fakeEnv({});
      expect((await executeResolveConflict(obs(), DEFAULT_CONFIG, cwd, env)).signal).toBe("agent.unavailable");
      expect(agentCalls).toHaveLength(0);
    });
  });

  describe("executeMerge", () => {
    it("merges through the gate", async () => {
      vi.mocked(merge).mockResolvedValue({ issue: 38 });
      expect(await executeMerge(obs(), DEFAULT_CONFIG, cwd)).toEqual({ signal: "task.merged", detail: "PR #62" });
      expect(merge).toHaveBeenCalledWith(62, DEFAULT_CONFIG, cwd, false);
    });

    it("reports a gate refusal as a failure instead of bypassing it", async () => {
      vi.mocked(merge).mockRejectedValue(new Error("merge blocked: CI not green"));
      expect(await executeMerge(obs(), DEFAULT_CONFIG, cwd)).toEqual({ signal: "step.failed", detail: "merge blocked: CI not green" });
    });
  });

  describe("executeEscalate", () => {
    it("labels the issue and explains why on the PR", async () => {
      const result = await executeEscalate(obs(), "CI is still failing after 3 fix rounds (limit 3)", cwd);
      expect(result.signal).toBe("task.escalated");
      expect(gh.editIssue).toHaveBeenCalledWith(38, { cwd, addLabels: ["needs-attention"] });
      expect(vi.mocked(gh.commentOnPr).mock.calls[0][1]).toContain("CI is still failing after 3 fix rounds");
    });

    it("tells the human how to hand the task back, including that a spent round budget must be raised first", async () => {
      await executeEscalate(obs(), "review feedback is still unresolved after 3 fix rounds (limit 3)", cwd);
      const comment = vi.mocked(gh.commentOnPr).mock.calls[0][1];

      expect(comment).toContain("Remove the `needs-attention` label");
      expect(comment).toContain("raise `maxReviewRounds`");
      expect(comment).toContain("escalate again straight away");
    });

    it("still escalates when the comment cannot be posted", async () => {
      vi.mocked(gh.commentOnPr).mockRejectedValue(new Error("offline"));
      expect((await executeEscalate(obs(), "why", cwd)).signal).toBe("task.escalated");
    });
  });

  describe("executeReview", () => {
    it("maps the verdict to a signal", async () => {
      const outcome = { reviewer: "claude", mode: "cross" as const, head: HEAD, issue: 38, author: "codex", notes: "", };
      vi.mocked(runAutomatedReview).mockResolvedValueOnce({ ...outcome, decision: "approve" });
      expect(await executeReview(obs(), DEFAULT_CONFIG, cwd)).toEqual({ signal: "review.approved", detail: "claude (cross)" });
      vi.mocked(runAutomatedReview).mockResolvedValueOnce({ ...outcome, decision: "request-changes" });
      expect((await executeReview(obs(), DEFAULT_CONFIG, cwd)).signal).toBe("review.changes_requested");
    });

    it("treats 'nobody can review right now' as an outage and anything else as a failure", async () => {
      vi.mocked(runAutomatedReview).mockRejectedValueOnce(new NoReviewerError("no reviewer available"));
      expect((await executeReview(obs(), DEFAULT_CONFIG, cwd)).signal).toBe("agent.unavailable");
      vi.mocked(runAutomatedReview).mockRejectedValueOnce(new Error("produced no valid verdict"));
      expect(await executeReview(obs(), DEFAULT_CONFIG, cwd)).toEqual({ signal: "step.failed", detail: "produced no valid verdict" });
    });
  });
});
