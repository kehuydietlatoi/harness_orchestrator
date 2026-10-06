import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";

vi.mock("../src/github/github.js", () => ({
  editIssue: vi.fn(), commentOnPr: vi.fn(), failingChecks: vi.fn(), getPr: vi.fn(), getIssue: vi.fn(),
  prDiff: vi.fn(), listPrReviews: vi.fn(), recordPrReview: vi.fn(), prChecksPass: vi.fn(), mergePr: vi.fn(),
}));
vi.mock("../src/git/git.js", () => ({ resolveBaseBranch: vi.fn() }));
vi.mock("../src/git/worktree.js", () => ({ worktreePath: vi.fn(), removeWorktree: vi.fn() }));
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
import { worktreePath } from "../src/git/worktree.js";
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
  ancestor?: boolean;
}) {
  const agentCalls: Array<Parameters<StepEnv["runAgent"]>[0]> = [];
  const gitCalls: string[][] = [];
  const env: StepEnv = {
    runAgent: async (ctx) => {
      agentCalls.push(ctx);
      const r = opts.runs?.[agentCalls.length - 1] ?? { ok: true };
      if (r.log && ctx.logFile) writeFileSync(ctx.logFile, r.log, "utf8");
      return { ok: r.ok ?? true, code: r.code ?? (r.ok === false ? 1 : 0), durationMs: 5, timedOut: r.timedOut ?? false, sessionId: r.sessionId };
    },
    git: async (args) => {
      gitCalls.push(args);
      const ok = { code: 0, stderr: "" };
      if (args[0] === "rev-parse") return { ...ok, stdout: `${opts.head ?? NEW_HEAD}\n` };
      if (args[0] === "status") return { ...ok, stdout: opts.dirty ? " M file.ts\n" : "" };
      if (args[0] === "push") return { code: opts.pushCode ?? 0, stdout: "", stderr: opts.pushCode ? "rejected" : "" };
      if (args[0] === "merge-base") return { code: opts.ancestor === false ? 1 : 0, stdout: "", stderr: "" };
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
    vi.mocked(worktreePath).mockReturnValue(wt);
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
        expect.any(String), cwd, DEFAULT_CONFIG, { phase: "fix", round: 1 });
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
        expect.any(String), cwd, DEFAULT_CONFIG, { phase: "fix", round: 1 });
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
      vi.mocked(worktreePath).mockReturnValue(join(wt, "does-not-exist"));
      const { env, agentCalls } = fakeEnv({});
      const result = await executeFix(obs(), "review", DEFAULT_CONFIG, cwd, env);
      expect(result.detail).toContain("orch repair 38");
      expect(agentCalls).toHaveLength(0);
    });

    it("reports a generic crash as a failure, not an outage", async () => {
      const { env } = fakeEnv({ runs: [{ ok: false, code: 2 }, { ok: false, code: 2 }] });
      const result = await executeFix(obs(), "review", DEFAULT_CONFIG, cwd, env);
      expect(result).toEqual({ signal: "step.failed", detail: "'codex' exited 2" });
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
      expect(gitCalls[0]).toEqual(["fetch", "origin", "main"]);
      expect(agentCalls[0].agent).toBe("claude");
      expect(agentCalls[0].prompt).toContain("git merge origin/main");
      expect(agentCalls[0].prompt).toContain("not a rebase");
      expect(gitCalls.some((a) => a[0] === "merge-base" && a.includes("origin/main"))).toBe(true);
      expect(gitCalls.some((a) => a[0] === "push")).toBe(true);
      expect(recordRun).toHaveBeenCalledWith(38, "claude", expect.anything(), "resolve-pushed", expect.any(Number),
        expect.any(String), cwd, DEFAULT_CONFIG, { phase: "resolve-conflict", round: 1 });
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
