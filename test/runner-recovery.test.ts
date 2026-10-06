import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config.js";

const mocks = vi.hoisted(() => ({
  claimNext: vi.fn(),
  submit: vi.fn(),
  buildBrief: vi.fn(() => "brief"),
  makeAdapter: vi.fn(),
  runTask: vi.fn(),
  getIssue: vi.fn(),
  editIssue: vi.fn(),
  lockRelease: vi.fn(),
  removeWorktree: vi.fn(),
  discardWorktree: vi.fn(),
  appendRun: vi.fn(),
  parseUsage: vi.fn(() => ({
    tokensIn: null,
    tokensOut: null,
    tokensTotal: null,
    costUsd: null,
  })),
  projectId: vi.fn(() => "project"),
  projectStateDir: vi.fn(),
  resolveBaseBranch: vi.fn(),
  countCommitsAhead: vi.fn(),
}));

vi.mock("../src/tasks/service.js", () => ({
  claimNext: mocks.claimNext,
  submit: mocks.submit,
}));
vi.mock("../src/tasks/brief.js", () => ({ buildBrief: mocks.buildBrief }));
vi.mock("../src/adapters/index.js", () => ({
  makeAdapter: mocks.makeAdapter,
}));
vi.mock("../src/github/github.js", () => ({
  getIssue: mocks.getIssue,
  editIssue: mocks.editIssue,
}));
vi.mock("../src/git/lock.js", () => ({ release: mocks.lockRelease }));
vi.mock("../src/git/worktree.js", () => ({
  removeWorktree: mocks.removeWorktree,
  discardWorktree: mocks.discardWorktree,
}));
vi.mock("../src/board/telemetry.js", () => ({
  appendRun: mocks.appendRun,
  parseUsage: mocks.parseUsage,
  projectId: mocks.projectId,
  projectStateDir: mocks.projectStateDir,
}));
vi.mock("../src/git/git.js", () => ({
  resolveBaseBranch: mocks.resolveBaseBranch,
  countCommitsAhead: mocks.countCommitsAhead,
}));

const { processNext, recordRun, runLoop } = await import("../src/tasks/runner.js");
const { unavailableUntil } = await import("../src/board/availability.js");

const issue = {
  number: 35,
  title: "Recover runner failures",
  body: "",
  state: "OPEN" as const,
  labels: ["status:claimed", "agent:codex"],
  assignees: [],
};

describe("processNext recovery", () => {
  let cwd: string;
  let worktree: string;

  beforeEach(() => {
    vi.clearAllMocks();
    cwd = mkdtempSync(join(tmpdir(), "orch-runner-recovery-"));
    worktree = join(cwd, "worktree");
    mkdirSync(worktree);
    mocks.projectStateDir.mockReturnValue(join(cwd, ".state")); // real availability store, isolated per test
    mocks.claimNext.mockResolvedValue({ issue, worktree: { path: worktree, branch: "task/35" } });
    mocks.makeAdapter.mockReturnValue({ id: "codex", runTask: mocks.runTask });
    mocks.editIssue.mockResolvedValue(undefined);
    mocks.removeWorktree.mockResolvedValue(true);
    mocks.lockRelease.mockResolvedValue(true);
    mocks.appendRun.mockReturnValue(undefined);
    mocks.resolveBaseBranch.mockResolvedValue({ name: "main", ref: "refs/heads/main" });
    mocks.countCommitsAhead.mockResolvedValue(0);
  });

  afterEach(() => {
    expect(mocks.discardWorktree).not.toHaveBeenCalled();
    rmSync(cwd, { recursive: true, force: true });
  });

  it("passes the routing requirement through to the claim", async () => {
    mocks.claimNext.mockResolvedValue(null);

    expect(await processNext("codex", DEFAULT_CONFIG, cwd, { requireRouted: true })).toBeNull();
    expect(mocks.claimNext).toHaveBeenLastCalledWith("codex", DEFAULT_CONFIG, cwd, { requireRouted: true });

    await processNext("codex", DEFAULT_CONFIG, cwd);
    expect(mocks.claimNext).toHaveBeenLastCalledWith("codex", DEFAULT_CONFIG, cwd, {});
  });

  describe("judging a failed run by its own log (the issue log is shared by every retry)", () => {
    const LIMIT =
      '{"type":"turn.failed","error":{"message":"You hit your usage limit. try again at 11:59 PM."}}\n';
    const failed = { ok: false, code: 1, durationMs: 1, timedOut: false };

    it("does not pause the harness for a new failure just because an earlier attempt hit a usage limit", async () => {
      mkdirSync(join(cwd, "logs"), { recursive: true });
      appendFileSync(join(cwd, "logs", "issue-35.jsonl"), LIMIT, "utf8"); // an earlier attempt, long since reset
      mocks.runTask.mockResolvedValue(failed); // this attempt fails for an unrelated reason

      const outcome = await processNext("codex", DEFAULT_CONFIG, cwd);

      expect(outcome).toMatchObject({ issue: 35, outcome: "failed" });
      expect(unavailableUntil("codex", cwd)).toBeNull();
    });

    it("does pause the harness when this run's own output shows the limit", async () => {
      mkdirSync(join(cwd, "logs"), { recursive: true });
      appendFileSync(join(cwd, "logs", "issue-35.jsonl"), "earlier attempt, no limit event\n", "utf8");
      mocks.runTask.mockImplementation(async (ctx: { logFile: string }) => {
        appendFileSync(ctx.logFile, LIMIT, "utf8");
        return failed;
      });

      await processNext("codex", DEFAULT_CONFIG, cwd);

      expect(unavailableUntil("codex", cwd)).not.toBeNull();
    });
  });

  describe("a run that dies on a usage limit goes back to the queue instead of needing a human", () => {
    const LIMIT =
      '{"type":"turn.failed","error":{"message":"You hit your usage limit. try again at 11:59 PM."}}\n';
    const dies = async (ctx: { logFile: string }) => {
      appendFileSync(ctx.logFile, LIMIT, "utf8");
      return { ok: false, code: 1, durationMs: 1, timedOut: false };
    };

    it("requeues to status:todo (no needs-attention), releasing worktree and lock first", async () => {
      mocks.runTask.mockImplementation(dies);
      const order: string[] = [];
      mocks.removeWorktree.mockImplementation(async () => (order.push("worktree"), true));
      mocks.lockRelease.mockImplementation(async () => (order.push("lock"), true));
      mocks.editIssue.mockImplementation(async (_n: number, o: { addLabels?: string[] }) => {
        order.push(`labels:${o.addLabels?.join(",")}`);
      });

      const outcome = await processNext("codex", DEFAULT_CONFIG, cwd);

      expect(outcome).toMatchObject({ issue: 35, outcome: "requeued" });
      expect(order.slice(-3)).toEqual(["worktree", "lock", "labels:status:todo"]);
      expect(mocks.editIssue).toHaveBeenLastCalledWith(35, {
        cwd,
        addLabels: ["status:todo"],
        removeLabels: ["status:claimed", "status:in-progress"],
      });
      expect(mocks.editIssue).not.toHaveBeenCalledWith(35, expect.objectContaining({ addLabels: ["needs-attention"] }));
      // "usage-limited" must not read as a failed run, or the lifecycle would park the requeued task.
      expect(mocks.appendRun.mock.calls[0][0]).toMatchObject({ issue: 35, outcome: "usage-limited" });
      expect(unavailableUntil("codex", cwd)).not.toBeNull(); // and the harness is still paused
    });

    it("keeps the claim and flags needs-attention when work was left behind", async () => {
      mocks.runTask.mockImplementation(dies);
      mocks.removeWorktree.mockResolvedValue(false); // dirty / committed: safe cleanup retains it

      const outcome = await processNext("codex", DEFAULT_CONFIG, cwd);

      expect(outcome).toMatchObject({ issue: 35, outcome: "failed" });
      expect(mocks.lockRelease).not.toHaveBeenCalled();
      expect(mocks.editIssue).not.toHaveBeenCalledWith(35, expect.objectContaining({ addLabels: ["status:todo"] }));
      expect(mocks.editIssue).toHaveBeenLastCalledWith(35, expect.objectContaining({ addLabels: ["needs-attention"] }));
      expect(mocks.appendRun.mock.calls[0][0]).toMatchObject({ outcome: "failed" });
    });

    // git.release() signals failure by RETURNING false (update-ref failed), not by throwing.
    it.each([
      ["returns false", () => mocks.lockRelease.mockResolvedValue(false)],
      ["throws", () => mocks.lockRelease.mockRejectedValue(new Error("lock busy"))],
    ])("falls back to needs-attention, never todo, when releasing the lock %s", async (_name, arrange) => {
      mocks.runTask.mockImplementation(dies);
      arrange();

      const outcome = await processNext("codex", DEFAULT_CONFIG, cwd);

      expect(outcome).toMatchObject({ issue: 35, outcome: "failed" });
      expect(mocks.editIssue).not.toHaveBeenCalledWith(35, expect.objectContaining({ addLabels: ["status:todo"] }));
      expect(mocks.editIssue).toHaveBeenLastCalledWith(35, expect.objectContaining({ addLabels: ["needs-attention"] }));
      expect(mocks.appendRun.mock.calls[0][0]).toMatchObject({ outcome: "failed" });
    });

    it("does not requeue a plain failure (no usage-limit event in this run's own output)", async () => {
      mocks.runTask.mockResolvedValue({ ok: false, code: 1, durationMs: 1, timedOut: false });

      expect(await processNext("codex", DEFAULT_CONFIG, cwd)).toMatchObject({ outcome: "failed" });
      expect(mocks.editIssue).not.toHaveBeenCalledWith(35, expect.objectContaining({ addLabels: ["status:todo"] }));
    });
  });

  describe("usage telemetry reads only the run's own log range", () => {
    it("recordRun parses just the bytes after `since`, never an earlier attempt's usage", () => {
      mkdirSync(join(cwd, "logs"), { recursive: true });
      const logFile = join(cwd, "logs", "issue-35-fix1.jsonl");
      appendFileSync(logFile, "EARLIER ATTEMPT USAGE\n", "utf8");
      const since = statSync(logFile).size;
      appendFileSync(logFile, "THIS RUN ONLY\n", "utf8");
      mocks.parseUsage.mockClear();

      recordRun(35, "codex", undefined, "fix-pushed", 1, logFile, cwd, DEFAULT_CONFIG, { since });

      expect(mocks.parseUsage).toHaveBeenCalledWith("THIS RUN ONLY\n", "codex");
    });

    it("recordRun without a range still reads the whole log (compatible default)", () => {
      mkdirSync(join(cwd, "logs"), { recursive: true });
      const logFile = join(cwd, "logs", "whole.jsonl");
      appendFileSync(logFile, "ALL OF IT\n", "utf8");
      mocks.parseUsage.mockClear();

      recordRun(35, "codex", undefined, "submitted", 1, logFile, cwd, DEFAULT_CONFIG);

      expect(mocks.parseUsage).toHaveBeenCalledWith("ALL OF IT\n", "codex");
    });

    it("a retry that reports no usage does not inherit the earlier attempt's usage (implement path)", async () => {
      mkdirSync(join(cwd, "logs"), { recursive: true });
      appendFileSync(join(cwd, "logs", "issue-35.jsonl"), '{"type":"turn.completed","usage":{"input_tokens":999}}\n', "utf8");
      mocks.runTask.mockImplementation(async (ctx: { logFile: string }) => {
        appendFileSync(ctx.logFile, '{"type":"turn.started"}\n', "utf8"); // this attempt reports no usage at all
        return { ok: false, code: 1, durationMs: 1, timedOut: false };
      });
      mocks.parseUsage.mockClear();

      await processNext("codex", DEFAULT_CONFIG, cwd);

      const parsed = mocks.parseUsage.mock.calls.at(-1)?.[0] as string;
      expect(parsed).toBe('{"type":"turn.started"}\n');
      expect(parsed).not.toContain("999");
    });
  });

  it("reports the claimed issue before the harness runs, so a caller can leave its PR alone meanwhile", async () => {
    const order: string[] = [];
    mocks.runTask.mockImplementation(async () => {
      order.push("run");
      return { ok: false, code: 1, durationMs: 1, timedOut: false };
    });

    await processNext("codex", DEFAULT_CONFIG, cwd, { onClaimed: (n) => order.push(`claimed:${n}`) });

    expect(order).toEqual(["claimed:35", "run"]);
  });

  it("returns one failed outcome and records it once when adapter execution rejects", async () => {
    mocks.runTask.mockRejectedValue(new Error("adapter exploded"));

    const outcome = await processNext("codex", DEFAULT_CONFIG, cwd);

    expect(outcome).toMatchObject({ issue: 35, outcome: "failed" });
    expect(mocks.editIssue).toHaveBeenLastCalledWith(35, {
      cwd,
      addLabels: ["needs-attention"],
      removeLabels: ["status:claimed", "status:in-progress"],
    });
    expect(mocks.removeWorktree).toHaveBeenCalledOnce();
    expect(mocks.lockRelease).toHaveBeenCalledOnce();
    expect(mocks.appendRun).toHaveBeenCalledOnce();
    expect(mocks.appendRun.mock.calls[0][0]).toMatchObject({ issue: 35, outcome: "failed" });
  });

  it("returns one failed outcome when the child process cannot start", async () => {
    mocks.runTask.mockResolvedValue({
      ok: false,
      code: 127,
      durationMs: 10,
      timedOut: false,
    });

    const outcome = await processNext("codex", DEFAULT_CONFIG, cwd);

    expect(outcome).toEqual({ issue: 35, outcome: "failed", durationMs: 10 });
    expect(mocks.removeWorktree).toHaveBeenCalledOnce();
    expect(mocks.lockRelease).toHaveBeenCalledOnce();
    expect(mocks.appendRun).toHaveBeenCalledOnce();
  });

  it("recovers an adapter construction failure through the same boundary", async () => {
    mocks.makeAdapter.mockImplementation(() => {
      throw new Error("adapter unavailable");
    });

    const outcome = await processNext("codex", DEFAULT_CONFIG, cwd);

    expect(outcome).toMatchObject({ issue: 35, outcome: "failed" });
    expect(mocks.removeWorktree).toHaveBeenCalledOnce();
    expect(mocks.appendRun).toHaveBeenCalledOnce();
  });

  it("keeps the outcome when the single telemetry attempt throws", async () => {
    mocks.runTask.mockResolvedValue({
      ok: false,
      code: 127,
      durationMs: 12,
      timedOut: false,
    });
    mocks.appendRun.mockImplementation(() => {
      throw new Error("telemetry unavailable");
    });

    const outcome = await processNext("codex", DEFAULT_CONFIG, cwd);

    expect(outcome).toEqual({ issue: 35, outcome: "failed", durationMs: 12 });
    expect(mocks.appendRun).toHaveBeenCalledOnce();
  });

  it("keeps retained committed work protected when submit fails", async () => {
    mocks.runTask.mockResolvedValue({
      ok: true,
      code: 0,
      durationMs: 24,
      timedOut: false,
    });
    mocks.getIssue.mockResolvedValue({ ...issue, labels: ["status:in-progress"] });
    mocks.countCommitsAhead.mockResolvedValue(1);
    mocks.submit.mockRejectedValue(new Error("push failed"));
    mocks.removeWorktree.mockResolvedValue(false);

    const outcome = await processNext("codex", DEFAULT_CONFIG, cwd);

    expect(outcome).toEqual({ issue: 35, outcome: "failed", durationMs: 24 });
    expect(mocks.removeWorktree).not.toHaveBeenCalled();
    expect(mocks.lockRelease).not.toHaveBeenCalled();
    expect(mocks.appendRun).toHaveBeenCalledOnce();
  });

  it("does not misclassify a git comparison failure as no commits", async () => {
    mocks.runTask.mockResolvedValue({
      ok: true,
      code: 0,
      durationMs: 25,
      timedOut: false,
    });
    mocks.getIssue.mockResolvedValue({ ...issue, labels: ["status:in-progress"] });
    mocks.countCommitsAhead.mockRejectedValue(new Error("git rev-list failed"));

    const outcome = await processNext("codex", DEFAULT_CONFIG, cwd);

    expect(outcome).toEqual({ issue: 35, outcome: "failed", durationMs: 25 });
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.removeWorktree).not.toHaveBeenCalled();
    expect(mocks.lockRelease).not.toHaveBeenCalled();
    expect(mocks.appendRun.mock.calls[0][0]).toMatchObject({ outcome: "failed" });
  });

  it("still finalizes once when safe cleanup itself fails", async () => {
    mocks.runTask.mockRejectedValue(new Error("adapter exploded"));
    mocks.removeWorktree.mockRejectedValue(new Error("worktree inspection failed"));

    const outcome = await processNext("codex", DEFAULT_CONFIG, cwd);

    expect(outcome).toMatchObject({ issue: 35, outcome: "failed" });
    expect(mocks.removeWorktree).toHaveBeenCalledOnce();
    expect(mocks.lockRelease).not.toHaveBeenCalled();
    expect(mocks.appendRun).toHaveBeenCalledOnce();
  });

  it("rejects the dispatcher when an unexpected pre-claim failure occurs", async () => {
    mocks.claimNext
      .mockRejectedValueOnce(new Error("issue lookup failed"))
      .mockResolvedValueOnce(null);

    await expect(runLoop("codex", DEFAULT_CONFIG, cwd, { max: 1 })).rejects.toThrow(
      "issue lookup failed",
    );
  });
});
