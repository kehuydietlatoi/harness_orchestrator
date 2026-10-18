import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, type OrchConfig } from "../src/config.js";
import type { Issue } from "../src/github/github.js";
import { markUnavailable, unavailableUntil } from "../src/board/availability.js";
import { readRuns } from "../src/board/telemetry.js";
import { incrementQuota, quotaPath } from "../src/board/quota.js";
vi.mock("../src/adapters/opencode.js", () => ({ OpencodeAdapter: class { async pingEndpoint() { return true; } } }));

const mocks = vi.hoisted(() => ({
  claimNext: vi.fn(), claimSpecific: vi.fn(), listIssues: vi.fn(), editIssue: vi.fn(),
  runTask: vi.fn(), removeWorktree: vi.fn(), release: vi.fn(),
}));
vi.mock("../src/tasks/service.js", () => ({ claimNext: mocks.claimNext, claimSpecific: mocks.claimSpecific }));
vi.mock("../src/tasks/brief.js", () => ({ buildBrief: () => "brief" }));
vi.mock("../src/adapters/index.js", () => ({ makeAdapter: () => ({ runTask: mocks.runTask }) }));
vi.mock("../src/github/github.js", () => ({
  listIssues: mocks.listIssues, editIssue: mocks.editIssue, listOpenPrs: async () => [],
}));
vi.mock("../src/git/git.js", () => ({
  resolveBaseBranch: async () => ({ name: "studio", ref: "refs/heads/studio" }), countCommitsAhead: async () => 0,
}));
vi.mock("../src/git/worktree.js", () => ({ removeWorktree: mocks.removeWorktree }));
vi.mock("../src/git/lock.js", () => ({ release: mocks.release }));

import { dispatchSpecific, processNext, recordRun } from "../src/tasks/runner.js";

const cfg: OrchConfig = {
  ...DEFAULT_CONFIG, agents: ["opencode"], defaultEffort: "free",
  adapters: { opencode: { cmd: "opencode", models: {
    free: { model: "zen/free" }, cheap: { model: "zen/cheap" }, standard: { model: "zen/standard" }, lead: { model: "zen/lead" },
  } } },
};
const issue = (number: number, tier: string): Issue => ({
  number, title: "Endpoint test", body: "", state: "OPEN", labels: ["agent:opencode", "status:todo", `effort:${tier}`], assignees: [],
});

describe("OpenCode endpoint dispatch and quota telemetry", () => {
  let cwd: string;
  beforeEach(() => {
    vi.clearAllMocks();
    cwd = mkdtempSync(join(tmpdir(), "orch-endpoint-"));
    mocks.editIssue.mockResolvedValue(undefined);
    mocks.removeWorktree.mockResolvedValue(true);
    mocks.release.mockResolvedValue(true);
    mocks.listIssues.mockResolvedValue([issue(1, "free"), issue(2, "cheap")]);
  });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

  it("blocks targeted claims on the cooled endpoint and allows another model", async () => {
    markUnavailable("opencode:zen/free", { resetAt: new Date(Date.now() + 600_000).toISOString(), reason: "503" }, cwd);
    await expect(dispatchSpecific(1, cfg, cwd)).rejects.toThrow(/opencode:zen\/free.*paused/);
    expect(mocks.claimSpecific).not.toHaveBeenCalled();
    mocks.claimSpecific.mockRejectedValue(new Error("reached claim"));
    await expect(dispatchSpecific(2, cfg, cwd)).rejects.toThrow("reached claim");
    expect(mocks.claimSpecific).toHaveBeenCalledWith(2, "opencode", cfg, cwd);
  });

  it("filters next-task candidates by their resolved model before claiming", async () => {
    markUnavailable("opencode:zen/free", { resetAt: new Date(Date.now() + 600_000).toISOString(), reason: "503" }, cwd);
    mocks.claimNext.mockImplementation(async (_agent, _cfg, _cwd, opts) => {
      expect(await opts.canClaim(issue(1, "free"))).toBe(false);
      expect(await opts.canClaim(issue(2, "cheap"))).toBe(true);
      return null;
    });
    expect(await processNext("opencode", cfg, cwd)).toBeNull();
    expect(mocks.claimNext).toHaveBeenCalledOnce();
  });

  it("requeues an endpoint refusal without needs-attention, even with exit zero", async () => {
    const task = issue(1, "free");
    mocks.claimNext.mockResolvedValue({ issue: task, worktree: { path: cwd, branch: "task/1" } });
    mocks.runTask.mockImplementation(async (ctx) => {
      appendFileSync(ctx.logFile, '{"type":"error","error":{"data":{"statusCode":503,"isRetryable":true}}}\n');
      return { ok: false, code: 0, durationMs: 10, timedOut: false };
    });
    expect(await processNext("opencode", cfg, cwd)).toMatchObject({ outcome: "requeued" });
    expect(unavailableUntil("opencode:zen/free", cwd)).not.toBeNull();
    expect(unavailableUntil("opencode", cwd)).toBeNull();
    expect(mocks.editIssue.mock.calls.some(([, opts]) => opts.addLabels?.includes("needs-attention"))).toBe(false);
    expect(mocks.editIssue).toHaveBeenLastCalledWith(1, expect.objectContaining({ addLabels: ["status:todo"] }));
    expect(readRuns(cwd)[0].outcome).toBe("usage-limited");
  });

  it("records reducer requests and zero quota cost, incrementing only this run's UTC daily endpoint total", () => {
    const log = join(cwd, "run.jsonl");
    const events = [
      { type: "step_start" }, { type: "step_finish", part: { reason: "stop", cost: 1.5, tokens: { input: 10, output: 2 } } },
      { type: "step_start" }, { type: "step_finish", part: { reason: "stop", cost: 2, tokens: { input: 20, output: 3 } } },
    ].map(e => JSON.stringify(e)).join("\n") + "\n";
    mkdirSync(join(cwd, "logs"));
    writeFileSync(log, "old run\n" + events);
    recordRun(1, "opencode", { model: "zen/free" }, "submitted", 10, log, cwd, cfg, { since: Buffer.byteLength("old run\n") });
    recordRun(1, "opencode", { model: "zen/free" }, "submitted", 10, log, cwd, cfg, { since: Buffer.byteLength("old run\n") });
    expect(readRuns(cwd)).toHaveLength(2);
    expect(readRuns(cwd)[0]).toMatchObject({ costUsd: 0, requests: 2, tokensIn: 30, tokensOut: 5 });
    const day = new Date().toISOString().slice(0, 10);
    expect(JSON.parse(readFileSync(quotaPath(cwd), "utf8"))[day]).toEqual({ "opencode:zen/free": 4 });
    incrementQuota("opencode:zen/cheap", 1, cwd, new Date("2020-01-01Z"));
    const totals = JSON.parse(readFileSync(quotaPath(cwd), "utf8"));
    expect(totals["2020-01-01"]).toEqual({ "opencode:zen/cheap": 1 });
    expect(totals[day]["opencode:zen/free"]).toBe(4);
  });
});
