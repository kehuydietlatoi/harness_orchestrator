import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
  exec: vi.fn(),
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
}));
vi.mock("../src/util/exec.js", () => ({ exec: mocks.exec }));

const { processNext, runLoop } = await import("../src/tasks/runner.js");

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
    mocks.claimNext.mockResolvedValue({ issue, worktree: { path: worktree, branch: "task/35" } });
    mocks.makeAdapter.mockReturnValue({ id: "codex", runTask: mocks.runTask });
    mocks.editIssue.mockResolvedValue(undefined);
    mocks.removeWorktree.mockResolvedValue(true);
    mocks.lockRelease.mockResolvedValue(true);
    mocks.appendRun.mockReturnValue(undefined);
  });

  afterEach(() => {
    expect(mocks.discardWorktree).not.toHaveBeenCalled();
    rmSync(cwd, { recursive: true, force: true });
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
    mocks.exec.mockResolvedValue({ code: 0, stdout: "1\n", stderr: "" });
    mocks.submit.mockRejectedValue(new Error("push failed"));
    mocks.removeWorktree.mockResolvedValue(false);

    const outcome = await processNext("codex", DEFAULT_CONFIG, cwd);

    expect(outcome).toEqual({ issue: 35, outcome: "failed", durationMs: 24 });
    expect(mocks.removeWorktree).not.toHaveBeenCalled();
    expect(mocks.lockRelease).not.toHaveBeenCalled();
    expect(mocks.appendRun).toHaveBeenCalledOnce();
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
