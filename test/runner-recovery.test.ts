import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config.js";
import { loadPack } from "../src/pack/load.js";
import { renderTicketV2 } from "../src/tasks/ticket-metadata.js";
import { readEvents } from "../src/tasks/events.js";
import { spawnLogged } from "../src/util/spawn.js";
import { assertStopped, cleanupDetached, detachedFixture } from "./helpers/process-containment.js";

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  claimNext: vi.fn(),
  claimSpecific: vi.fn(),
  listIssues: vi.fn(),
  submit: vi.fn(),
  buildBrief: vi.fn(() => "brief"),
  makeAdapter: vi.fn(),
  runTask: vi.fn(),
  getIssue: vi.fn(),
  editIssue: vi.fn(),
  ensureLabels: vi.fn(),
  listOpenPrs: vi.fn(),
  lockRelease: vi.fn(),
  removeWorktree: vi.fn(),
  discardWorktree: vi.fn(),
  readRuns: vi.fn(() => []),
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
vi.mock("../src/util/exec.js", () => ({ exec: mocks.exec }));

vi.mock("../src/tasks/service.js", () => ({
  claimNext: mocks.claimNext,
  claimSpecific: mocks.claimSpecific,
  submit: mocks.submit,
}));
vi.mock("../src/tasks/brief.js", () => ({ buildBrief: mocks.buildBrief }));
vi.mock("../src/adapters/index.js", () => ({
  makeAdapter: mocks.makeAdapter,
}));
vi.mock("../src/github/github.js", () => ({
  getIssue: mocks.getIssue,
  listIssues: mocks.listIssues,
  editIssue: mocks.editIssue,
  ensureLabels: mocks.ensureLabels,
  listOpenPrs: mocks.listOpenPrs,
}));
vi.mock("../src/git/lock.js", () => ({ release: mocks.lockRelease }));
vi.mock("../src/git/worktree.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/git/worktree.js")>(),
  removeWorktree: mocks.removeWorktree,
  discardWorktree: mocks.discardWorktree,
}));
vi.mock("../src/board/telemetry.js", () => ({
  readRuns: mocks.readRuns,
  appendRun: mocks.appendRun,
  parseUsage: mocks.parseUsage,
  projectId: mocks.projectId,
  projectStateDir: mocks.projectStateDir,
}));
vi.mock("../src/git/git.js", () => ({
  resolveBaseBranch: mocks.resolveBaseBranch,
  countCommitsAhead: mocks.countCommitsAhead,
}));

const { dispatchSpecific, processNext, recordRun, runLoop } = await import("../src/tasks/runner.js");
const { markUnavailable, unavailableUntil } = await import("../src/board/availability.js");

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
    mocks.exec.mockReset();
    mocks.exec.mockImplementation(async (_cmd: string, args: string[]) => ({
      code: 0, stderr: "", stdout: args[0] === "symbolic-ref" ? "task/35\n" : "",
    }));
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
    mocks.listOpenPrs.mockResolvedValue([]);
  });

  afterEach(() => {
    expect(mocks.discardWorktree).not.toHaveBeenCalled();
    rmSync(cwd, { recursive: true, force: true });
  });

  it.each(["exit", "timeout", "abort"])("processClaimed drains a fake harness's detached server on %s", async mode => {
    const record = join(cwd, "harness-child.json");
    mocks.runTask.mockImplementation(async () => {
      const result = await spawnLogged(process.execPath, [detachedFixture, record, mode === "exit" ? "exit" : "wait"], {
        cwd: worktree, timeoutMs: mode === "timeout" ? 3000 : 15000,
        abortOn: mode === "abort" ? line => line === "READY" ? "test abort" : undefined : undefined,
      });
      return { ...result, ok: result.code === 0 };
    });
    mocks.getIssue.mockResolvedValue({ ...issue, labels: ["status:in-review"] });
    // Recovery must never see a still-running harness descendant.
    mocks.removeWorktree.mockImplementation(async () => { await assertStopped(record); return true; });
    try {
      const result = await processNext("codex", DEFAULT_CONFIG, cwd);
      expect(result?.outcome).toBe(mode === "exit" ? "submitted" : "failed");
      await assertStopped(record);
    } finally { cleanupDetached(record); }
  }, 25000);

  it("drains a coordinator verify command before committing or submitting", async () => {
    const record = join(cwd, "verify-child.json");
    const { exec: realExec } = await vi.importActual<typeof import("../src/util/exec.js")>("../src/util/exec.js");
    mocks.runTask.mockResolvedValue({ ok: true, code: 0, durationMs: 1 });
    mocks.getIssue.mockResolvedValue(issue);
    mocks.exec.mockImplementation(async (cmd, args, opts) => {
      if (cmd === process.execPath) return realExec(cmd, args, opts);
      if (args[0] === "add" || args[0] === "commit") await assertStopped(record);
      return { code: 0, stderr: "", stdout: args[0] === "symbolic-ref" ? "task/35" : args[0] === "status" ? " M output.ts" : "" };
    });
    try {
      const result = await processNext("codex", { ...DEFAULT_CONFIG, verify: [[process.execPath, detachedFixture, record]] }, cwd);
      expect(result?.outcome).toBe("submitted");
      expect(mocks.submit).toHaveBeenCalled();
      await assertStopped(record);
    } finally { cleanupDetached(record); }
  }, 25000);

  it("hands an exhausted budget to a human without a harness invocation or run record", async () => {
    const result = await processNext("codex", { ...DEFAULT_CONFIG, budgets: { default: { requests: 0 } } }, cwd);
    expect(result).toMatchObject({ issue: 35, outcome: "needs-attention", reason: "budget spent" });
    expect(mocks.runTask).not.toHaveBeenCalled();
    expect(mocks.appendRun).not.toHaveBeenCalled();
    expect(mocks.editIssue).toHaveBeenCalledWith(35, expect.objectContaining({ addLabels: ["needs-attention"] }));
  });

  it.each([{ needs: ["web"] as const }, { sensitivity: "secret" as const }])("refuses dispatch filters before claiming or constructing an adapter: %j", async metadata => {
    const agent = "needs" in metadata ? "codex" : "opencode";
    const task = { ...issue, body: renderTicketV2({ ...metadata, needs: "needs" in metadata ? [...metadata.needs] : undefined }), labels: ["agent:" + agent, "status:todo"] };
    mocks.listIssues.mockResolvedValue([task]);
    const cfg = { ...DEFAULT_CONFIG, agents: [...DEFAULT_CONFIG.agents, "opencode"], adapters: { ...DEFAULT_CONFIG.adapters, opencode: { cmd: "opencode" } } };
    expect(await dispatchSpecific(35, cfg, cwd)).toMatchObject({ outcome: "needs-attention", reason: "disallowed route" });
    expect(mocks.claimSpecific).not.toHaveBeenCalled();
    expect(mocks.makeAdapter).not.toHaveBeenCalled();
    expect(mocks.runTask).not.toHaveBeenCalled();
    expect(mocks.appendRun).not.toHaveBeenCalled();
    expect(readEvents(cwd).at(-1)?.detail).toMatch(/needs|sensitivity/);
    expect(mocks.exec).toHaveBeenCalledTimes(1);
    expect(mocks.exec).toHaveBeenCalledWith("gh", ["issue", "comment", "35", "--body-file", "-"], {
      cwd, input: readEvents(cwd).at(-1)?.detail,
    });
  });

  it.each(["nonzero", "rejected"])("preserves a spawn refusal when commenting fails: %s", async failure => {
    const task = { ...issue, body: renderTicketV2({ needs: ["web"] }), labels: ["agent:codex", "status:todo"] };
    mocks.listIssues.mockResolvedValue([task]);
    if (failure === "nonzero") mocks.exec.mockResolvedValue({ code: 1, stdout: "", stderr: "GitHub unavailable" });
    else mocks.exec.mockRejectedValue(new Error("GitHub unavailable"));
    expect(await dispatchSpecific(35, DEFAULT_CONFIG, cwd)).toMatchObject({ outcome: "needs-attention", reason: "disallowed route" });
    expect(mocks.exec).toHaveBeenCalledTimes(1);
    expect(mocks.editIssue).toHaveBeenCalledWith(35, expect.objectContaining({ addLabels: ["needs-attention"] }));
    expect(mocks.makeAdapter).not.toHaveBeenCalled();
    expect(mocks.appendRun).not.toHaveBeenCalled();
    expect(readEvents(cwd).at(-1)?.detail).toMatch(/needs web/);
  });

  it("rechecks filters on an already claimed task without recording a harness run", async () => {
    mocks.claimNext.mockResolvedValue({ issue: { ...issue, body: renderTicketV2({ needs: ["web"] }) }, worktree: { path: worktree, branch: "task/35" } });
    expect(await processNext("codex", DEFAULT_CONFIG, cwd)).toMatchObject({ outcome: "needs-attention" });
    expect(mocks.makeAdapter).not.toHaveBeenCalled();
    expect(mocks.appendRun).not.toHaveBeenCalled();
    expect(mocks.editIssue).toHaveBeenCalledWith(35, expect.objectContaining({ addLabels: ["needs-attention"] }));
  });

  it("leaves an unpinned vision task ready for Claude after shell-only Codex skips it", async () => {
    const config = { ...DEFAULT_CONFIG, adapters: { ...DEFAULT_CONFIG.adapters, codex: {
      ...DEFAULT_CONFIG.adapters.codex, models: { standard: { capabilities: ["shell"] }, lead: { capabilities: ["shell"] } },
    } } };
    const candidate = { ...issue, body: renderTicketV2({ needs: ["vision"] }), labels: ["status:todo"] };
    mocks.claimNext.mockImplementation(async (_agent, _cfg, _cwd, opts) => {
      if (!(await opts.canClaim(candidate))) return null;
      return { issue: candidate, worktree: { path: worktree, branch: "task/35" } };
    });

    expect(await processNext("codex", config, cwd)).toBeNull();
    expect(candidate.labels).toEqual(["status:todo"]);
    expect(mocks.editIssue).not.toHaveBeenCalled();
    expect(readEvents(cwd)).toEqual([]);
    expect(mocks.makeAdapter).not.toHaveBeenCalled();

    mocks.runTask.mockResolvedValue({ ok: true, code: 0, durationMs: 1 });
    mocks.countCommitsAhead.mockResolvedValue(1);
    mocks.getIssue.mockResolvedValue(candidate);
    expect(await processNext("claude", DEFAULT_CONFIG, cwd)).toMatchObject({ outcome: "submitted" });
    expect(mocks.makeAdapter).toHaveBeenCalledWith("claude", DEFAULT_CONFIG);
    expect(mocks.runTask).toHaveBeenCalledTimes(1);
    expect(mocks.editIssue.mock.calls.some(([, edit]) => edit.addLabels?.includes("needs-attention"))).toBe(false);
  });

  it.each(["empty required", "superseded decision", "missing anchor"])("refuses to spawn on %s and preserves the reason", async (problem) => {
    const pack = loadPack("test/fixtures/pack");
    mkdirSync(join(cwd, "design"));
    writeFileSync(join(cwd, "design/decisions.md"), "| D-001 | Old rule | superseded | D-002 | today |");
    const metadata = renderTicketV2({ role: "gameplay-programmer", kind: "code", verify: [["npm", "test"]],
      ...(problem === "superseded decision" ? { decisions: ["D-001"] } : {}),
      ...(problem === "missing anchor" ? { context: ["combat.missing"] } : {}),
    });
    const body = (problem === "empty required" ? "Goal.\n\n" : "Goal.\n\n## Definition of done\n- [ ] Test passes\n\n") + metadata;
    mocks.claimNext.mockResolvedValue({ issue: { ...issue, body }, worktree: { path: worktree, branch: "task/35" } });
    const result = await processNext("codex", { ...DEFAULT_CONFIG, pack: pack.path, loadedPack: pack }, cwd);
    expect(result?.outcome).toBe("needs-attention");
    expect(result?.reason).toMatch(problem === "empty required" ? /required ticket.acceptance/ : problem === "superseded decision" ? /D-001 is superseded/ : /anchor combat.missing/);
    expect(mocks.makeAdapter).not.toHaveBeenCalled();
    expect(mocks.runTask).not.toHaveBeenCalled();
    expect(mocks.appendRun).not.toHaveBeenCalled();
    expect(mocks.editIssue).toHaveBeenCalledWith(35, expect.objectContaining({ addLabels: ["needs-attention"], removeLabels: ["status:claimed", "status:in-progress"] }));
    expect(readEvents(cwd).at(-1)?.detail).toBe(result?.reason);
    expect(mocks.exec).toHaveBeenCalledTimes(1);
    expect(mocks.exec).toHaveBeenCalledWith("gh", ["issue", "comment", "35", "--body-file", "-"], {
      cwd, input: result?.reason,
    });
  });

  it("passes the stored pack brief to the harness", async () => {
    const pack = loadPack("test/fixtures/pack");
    const body = "Goal.\n\n## Definition of done\n- [ ] Test passes\n\n" + renderTicketV2({ role: "gameplay-programmer", verify: [["npm", "test"]] });
    mocks.claimNext.mockResolvedValue({ issue: { ...issue, body }, worktree: { path: worktree, branch: "task/35" } });
    mocks.runTask.mockResolvedValue({ ok: false, code: 1, durationMs: 1 });
    await processNext("codex", { ...DEFAULT_CONFIG, pack: pack.path, loadedPack: pack }, cwd);
    const stored = readFileSync(join(cwd, ".state/briefs/issue-35-1.md"), "utf8");
    expect(mocks.runTask.mock.calls[0][0].prompt).toBe(stored);
    expect(mocks.buildBrief).not.toHaveBeenCalled();
  });

  it("reports a ticket time budget cutoff as budget-spent", async () => {
    mocks.claimNext.mockResolvedValue({ issue: { ...issue, body: "Budget: 0.2m" }, worktree: { path: worktree, branch: "task/35" } });
    mocks.runTask.mockResolvedValue({ ok: false, code: 1, timedOut: true, durationMs: 12_300 });
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await processNext("codex", DEFAULT_CONFIG, cwd)).toMatchObject({ outcome: "needs-attention", reason: "budget spent" });
      expect(mocks.runTask).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 12_000 }));
      expect(mocks.appendRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "budget-spent", requests: 1 }), cwd);
      expect(output.mock.calls.flat().join("\n")).toContain("time budget spent");
      expect(output.mock.calls.flat().join("\n")).not.toContain("timed out");
    } finally { output.mockRestore(); }
  });

  it.each([undefined, 0, 3])("records at least one request per invocation (reported %s)", requests => {
    mocks.parseUsage.mockReturnValueOnce({ tokensIn: null, tokensOut: null, tokensTotal: null, costUsd: null, ...{ requests } });
    recordRun(35, "codex", undefined, "failed", 1, join(cwd, "missing.jsonl"), cwd, DEFAULT_CONFIG, { phase: "implement" });
    expect(mocks.appendRun).toHaveBeenCalledWith(expect.objectContaining({ requests: Math.max(1, requests ?? 1) }), cwd);
  });

  it("keeps an ordinary timeout when the harness deadline is shorter than the ticket budget", async () => {
    mocks.runTask.mockResolvedValue({ ok: false, code: 1, timedOut: true, durationMs: 1000 });
    expect(await processNext("codex", { ...DEFAULT_CONFIG, taskTimeoutMs: 1000, budgets: { default: { minutes: 1 } } }, cwd)).toMatchObject({ outcome: "failed" });
    expect(mocks.appendRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed", requests: 1 }), cwd);
  });

  it("does not call a non-timeout failure a budget stop", async () => {
    mocks.runTask.mockResolvedValue({ ok: false, code: 1, timedOut: false, durationMs: 1 });
    expect(await processNext("codex", { ...DEFAULT_CONFIG, budgets: { default: { minutes: 0.2 } } }, cwd)).toMatchObject({ outcome: "failed" });
  });

  it.each(["tracked", "untracked"])("rejects forbidden leftover %s output without committing or submitting", async kind => {
    const pack = loadPack("test/fixtures/pack");
    const body = "Goal.\n\n## Definition of done\n- [ ] Test passes\n\n" + renderTicketV2({ role: "gameplay-programmer", verify: [["npm", "test"]] });
    mocks.claimNext.mockResolvedValue({ issue: { ...issue, body, labels: [...issue.labels, "role:gameplay-programmer"] }, worktree: { path: worktree, branch: "task/35" } });
    mocks.runTask.mockResolvedValue({ ok: true, code: 0, durationMs: 1 });
    mocks.getIssue.mockResolvedValue(issue);
    mocks.exec.mockImplementation(async (_cmd: string, args: string[]) => ({ code: 0, stderr: "",
      stdout: args[0] === "symbolic-ref" ? "task/35" : args[0] === "status" ? " M design/game.md" :
        args[0] === (kind === "tracked" ? "diff" : "ls-files") ? "design/game.md\0" : "" }));
    const result = await processNext("codex", { ...DEFAULT_CONFIG, pack: pack.path, loadedPack: pack, roles: { "gameplay-programmer": { tiers: ["standard", "lead"], families: ["openai", "anthropic"] } }, verify: [["npm", "test"]] }, cwd);
    expect(result?.outcome).toBe("needs-attention");
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.exec.mock.calls.some(([cmd, argv]) => cmd === "npm" || argv[0] === "add" || argv[0] === "commit")).toBe(false);
    expect(mocks.exec).toHaveBeenCalledWith("gh", ["issue", "comment", "35", "--body-file", "-"], {
      cwd, input: expect.stringContaining('"design/game.md": forbidden by design/**'),
    });
    expect(mocks.editIssue).toHaveBeenCalledWith(35, expect.objectContaining({ addLabels: ["needs-attention"] }));
    expect(mocks.removeWorktree).not.toHaveBeenCalled();
    expect(mocks.lockRelease).not.toHaveBeenCalled();
  });

  it.each([0, 1])("retains an external node_modules link before verification or submission (commits: %s)", async commits => {
    const outside = join(cwd, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(worktree, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    mocks.runTask.mockResolvedValue({ ok: true, outcome: "completed", code: 0, durationMs: 24 });
    mocks.countCommitsAhead.mockResolvedValue(commits);
    mocks.exec.mockImplementation(async (_cmd, args) => ({ code: 0, stderr: "", stdout: args[0] === "status" ? " M worker.ts" : "" }));
    expect((await processNext("codex", { ...DEFAULT_CONFIG, verify: [["npm", "test"]] }, cwd))?.outcome).toBe("needs-attention");
    expect(mocks.exec.mock.calls.map(([cmd]) => cmd)).toEqual(["gh"]);
    const comment = mocks.exec.mock.calls[0][2].input;
    expect(comment).toContain("node_modules");
    expect(comment).toContain(JSON.stringify(outside));
    expect(mocks.editIssue).toHaveBeenCalledWith(35, expect.objectContaining({ addLabels: ["needs-attention"] }));
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.removeWorktree).not.toHaveBeenCalled();
    expect(mocks.lockRelease).not.toHaveBeenCalled();
    expect(statSync(worktree).isDirectory()).toBe(true);
  });

  it.each(["codex", "claude", "opencode"])("verifies, commits and submits uncommitted output from %s", async (agent) => {
    mocks.runTask.mockResolvedValue({ ok: true, outcome: "completed", code: 0, durationMs: 24 });
    mocks.getIssue.mockResolvedValue({ ...issue, labels: ["status:in-progress"] });
    mocks.submit.mockResolvedValue("https://example.test/pull/1");
    mocks.exec.mockImplementation(async (_cmd: string, args: string[]) => ({
      code: 0, stderr: "", stdout: args[0] === "symbolic-ref" ? "task/35\n" : args[0] === "status" ? "?? greet.js\n" : "",
    }));
    const cfg = { ...DEFAULT_CONFIG, verify: [["node", "--test"], ["npm", "test"]] };
    const result = await processNext(agent, cfg, cwd);
    expect(result?.outcome).toBe("submitted");
    const calls = mocks.exec.mock.calls;
    expect(calls.map(([cmd, argv]) => [cmd, argv])).toEqual([
      ["git", ["symbolic-ref", "--short", "HEAD"]],
      ["git", ["status", "--porcelain", "--untracked-files=all"]],
      ["node", ["--test"]], ["npm", ["test"]],
      ["git", ["symbolic-ref", "--short", "HEAD"]],
      ["git", ["add", "--all"]],
      ["git", ["commit", "-m", "Recover runner failures (#35)", "-m",
        `Worker: ${agent}; model: ${agent === "opencode" ? "default" : agent === "codex" ? "gpt-6.1-sol@medium" : "claude-sonnet-5-5@medium"}`]],
    ]);
    expect(mocks.exec).toHaveBeenCalledWith("node", ["--test"], { cwd: worktree, timeoutMs: 300_000, env: expect.any(Object), contain: true });
    expect(mocks.submit).toHaveBeenCalledWith(35, agent, cfg, cwd);
    expect(mocks.removeWorktree).not.toHaveBeenCalled();
  });

  it("commits and submits without checks when verify is omitted", async () => {
    mocks.runTask.mockResolvedValue({ ok: true, code: 0, durationMs: 1 });
    mocks.getIssue.mockResolvedValue(issue);
    mocks.exec.mockImplementation(async (_cmd: string, args: string[]) => ({ code: 0, stderr: "",
      stdout: args[0] === "symbolic-ref" ? "task/35" : args[0] === "status" ? " M greet.js" : "" }));
    expect((await processNext("codex", DEFAULT_CONFIG, cwd))?.outcome).toBe("submitted");
    expect(mocks.exec.mock.calls.every(([cmd]) => cmd === "git")).toBe(true);
  });

  it("runs ticket checks after project checks with a cleaned environment in the worktree", async () => {
    const secrets = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "SERVICE_API_KEY", "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "OPENCODE_CONFIG", "CODEX_HOME", "github_token", "NODE_AUTH_TOKEN"];
    for (const key of secrets) vi.stubEnv(key, "test-secret");
    vi.stubEnv("NODE_ENV", "test");
    try {
      const body = '## Ticket metadata (v2)\n\n```json\n' + JSON.stringify({ verify: [["node", "--test", "--", "tests/a.test.ts", "3"]] }) + '\n```';
      mocks.claimNext.mockResolvedValue({ issue: { ...issue, body }, worktree: { path: worktree, branch: "task/35" } });
      mocks.runTask.mockResolvedValue({ ok: true, code: 0, durationMs: 1 });
      mocks.getIssue.mockResolvedValue(issue);
      mocks.exec.mockImplementation(async (_cmd: string, args: string[]) => ({ code: 0, stderr: "",
        stdout: args[0] === "symbolic-ref" ? "task/35" : args[0] === "status" ? " M a.ts" : "" }));
      expect((await processNext("codex", { ...DEFAULT_CONFIG, verify: [["node", "--test"]] }, cwd))?.outcome).toBe("submitted");
      const checks = mocks.exec.mock.calls.filter(([cmd]) => cmd === "node");
      expect(checks.map(([, argv]) => argv)).toEqual([["--test"], ["--test", "--", "tests/a.test.ts", "3"]]);
      for (const [, , opts] of checks) {
        expect(opts).toMatchObject({ cwd: worktree, timeoutMs: 300_000, env: { NODE_ENV: "test" } });
        for (const key of secrets) expect(opts.env).not.toHaveProperty(key);
        const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH")!;
        expect(opts.env[pathKey]).toBe(process.env[pathKey]);
      }
    } finally { vi.unstubAllEnvs(); }
  });

  it("revalidates issue verify at runtime before executing host checks", async () => {
    const body = '## Ticket metadata (v2)\n\n```json\n{"verify":[["node","--test","--require","evil.js"]]}\n```';
    mocks.claimNext.mockResolvedValue({ issue: { ...issue, body }, worktree: { path: worktree, branch: "task/35" } });
    mocks.runTask.mockResolvedValue({ ok: true, code: 0, durationMs: 1 });
    mocks.getIssue.mockResolvedValue(issue);
    mocks.exec.mockImplementation(async (_cmd: string, args: string[]) => ({ code: 0, stderr: "",
      stdout: args[0] === "symbolic-ref" ? "task/35" : args[0] === "status" ? " M a.ts" : "" }));
    expect((await processNext("codex", { ...DEFAULT_CONFIG, verify: [["node", "--test"]] }, cwd))?.outcome).toBe("needs-attention");
    expect(mocks.exec.mock.calls.some(([cmd]) => cmd === "node")).toBe(false);
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.removeWorktree).not.toHaveBeenCalled();
  });

  it.each([1, 124])("retains output and comments a failed verification (exit %s)", async code => {
    mocks.runTask.mockResolvedValue({ ok: true, code: 0, durationMs: 1 });
    mocks.getIssue.mockResolvedValue(issue);
    mocks.exec.mockImplementation(async (cmd: string, args: string[]) => ({
      code: cmd === "node" ? code : 0, stderr: cmd === "node" ? "check failed" : "",
      stdout: args[0] === "symbolic-ref" ? "task/35" : args[0] === "status" ? "?? greet.js" : "x".repeat(7000),
    }));
    const result = await processNext("codex", { ...DEFAULT_CONFIG, verify: [["node", "--test"], ["npm", "test"]] }, cwd);
    expect(result?.outcome).toBe("needs-attention");
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.exec.mock.calls.some(([, argv]) => argv[0] === "add" || argv[0] === "commit")).toBe(false);
    expect(mocks.exec).not.toHaveBeenCalledWith("npm", expect.anything(), expect.anything());
    expect(mocks.exec).toHaveBeenCalledWith("gh", ["issue", "comment", "35", "--body-file", "-"], {
      cwd, input: expect.stringContaining('Command (argv): ["node","--test"]'),
    });
    expect(mocks.exec.mock.calls.at(-1)?.[2].input).toContain("check failed");
    expect(mocks.exec.mock.calls.at(-1)?.[2].input.length).toBeLessThan(6500);
    expect(mocks.editIssue).toHaveBeenLastCalledWith(35, expect.objectContaining({ addLabels: ["needs-attention"] }));
    expect(mocks.removeWorktree).not.toHaveBeenCalled();
    expect(mocks.lockRelease).not.toHaveBeenCalled();
    expect(mocks.appendRun).toHaveBeenCalledOnce();
  });

  it("flags a completed run with a clean worktree and no commits", async () => {
    mocks.runTask.mockResolvedValue({ ok: true, code: 0, durationMs: 1 });
    mocks.getIssue.mockResolvedValue(issue);
    expect((await processNext("codex", DEFAULT_CONFIG, cwd))?.outcome).toBe("needs-attention");
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.exec.mock.calls.some(([, argv]) => argv[0] === "commit")).toBe(false);
  });

  it.each(["status", "commit", "branch"])("retains worker output on %s failure", async failure => {
    mocks.runTask.mockResolvedValue({ ok: true, code: 0, durationMs: 1 });
    mocks.getIssue.mockResolvedValue(issue);
    mocks.exec.mockImplementation(async (_cmd: string, args: string[]) => ({
      code: args[0] === failure ? 1 : 0, stderr: "git failed",
      stdout: args[0] === "symbolic-ref" ? failure === "branch" ? "other-branch" : "task/35" : args[0] === "status" ? "?? greet.js" : "",
    }));
    expect((await processNext("codex", DEFAULT_CONFIG, cwd))?.outcome).toBe("failed");
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.removeWorktree).not.toHaveBeenCalled();
    expect(mocks.lockRelease).not.toHaveBeenCalled();
  });

  it("passes the routing requirement through to the claim", async () => {
    mocks.claimNext.mockResolvedValue(null);

    expect(await processNext("codex", DEFAULT_CONFIG, cwd, { requireRouted: true })).toBeNull();
    expect(mocks.claimNext).toHaveBeenLastCalledWith("codex", DEFAULT_CONFIG, cwd, expect.objectContaining({ requireRouted: true, canClaim: expect.any(Function) }));

    await processNext("codex", DEFAULT_CONFIG, cwd);
    expect(mocks.claimNext).toHaveBeenLastCalledWith("codex", DEFAULT_CONFIG, cwd, expect.objectContaining({ canClaim: expect.any(Function) }));
  });

  it.each(["endpoint-unavailable", "quota"] as const)("cascades %s to a projected member and records one hop", async (outcome) => {
    const from = { agent: "opencode", tier: "free" as const, model: "zen/free", family: "openai" };
    const cooled = { ...from, model: "zen/cooled" };
    const to = { agent: "opencode", tier: "cheap" as const, model: "zen/cheap", family: "openai", effort: "high" };
    const cfg = {
      ...DEFAULT_CONFIG, agents: [...DEFAULT_CONFIG.agents, "opencode"],
      adapters: { ...DEFAULT_CONFIG.adapters, opencode: { cmd: "opencode" } },
      tierMembers: { free: [from, cooled], cheap: [to], standard: [], lead: [] },
    };
    markUnavailable("opencode:zen/cooled", { resetAt: null, reason: "known outage" }, cwd);
    mocks.claimNext.mockResolvedValue({ issue: { ...issue, labels: ["agent:opencode", "effort:free", "status:claimed"] }, worktree: { path: worktree, branch: "task/35" } });
    mocks.runTask.mockResolvedValue({ ok: false, outcome, code: 1, durationMs: 1, timedOut: false });
    const started = Date.now();
    const onCascade = vi.fn();
    const result = await processNext("opencode", cfg, cwd, { onCascade });
    expect(onCascade).toHaveBeenCalledOnce();
    expect(onCascade).toHaveBeenCalledWith("opencode");
    const cooldownMs = outcome === "endpoint-unavailable" ? 10 * 60_000 : 60 * 60_000;
    const until = unavailableUntil("opencode:zen/free", cwd)!.getTime();
    expect(until).toBeGreaterThanOrEqual(started + cooldownMs);
    expect(until).toBeLessThanOrEqual(Date.now() + cooldownMs);
    expect(result?.outcome).toBe("requeued");
    expect(mocks.editIssue).toHaveBeenLastCalledWith(35, {
      cwd, addLabels: ["status:todo", "agent:opencode", "effort:cheap", "model:zen/cheap"],
      removeLabels: ["status:claimed", "status:in-progress", "effort:free", "needs-attention"],
    });
    expect(mocks.ensureLabels).toHaveBeenCalledOnce();
    expect(mocks.appendRun).toHaveBeenCalledOnce();
    expect(mocks.appendRun).toHaveBeenCalledWith(expect.objectContaining({ cascadeFrom: from, cascadeTo: to, outcome: "usage-limited" }), cwd);
    const { readEvents } = await import("../src/tasks/events.js");
    expect(readEvents(cwd).filter((event) => event.type === "cascade.hop")).toEqual([
      expect.objectContaining({ issue: 35, cascadeFrom: from, cascadeTo: to }),
    ]);
    // The relabelled task selects the new model rather than its old adapter default.
    const { resolveTaskModel } = await import("../src/tasks/runner.js");
    expect(resolveTaskModel("opencode", { ...issue, labels: ["effort:cheap", "model:zen/cheap"] }, cfg)).toMatchObject({ model: "zen/cheap", effort: "high" });
  });

  it.each(["commits", "retained", "lock", "labels"])("does not record a hop when cascade requeue fails at %s", async (failure) => {
    const cfg = { ...DEFAULT_CONFIG, tierMembers: { free: [], cheap: [], standard: [], lead: [{ agent: "codex" }, { agent: "claude" }] } };
    mocks.runTask.mockResolvedValue({ ok: false, outcome: "quota", code: 1, durationMs: 1, timedOut: false });
    if (failure === "commits") mocks.countCommitsAhead.mockResolvedValue(1);
    if (failure === "retained") mocks.removeWorktree.mockResolvedValue(false);
    if (failure === "lock") mocks.lockRelease.mockResolvedValue(false);
    if (failure === "labels") mocks.ensureLabels.mockRejectedValueOnce(new Error("labels unavailable"));
    const onCascade = vi.fn();
    expect((await processNext("codex", cfg, cwd, { onCascade }))?.outcome).toBe("failed");
    expect(onCascade).not.toHaveBeenCalled();
    expect(mocks.appendRun).toHaveBeenCalledWith(expect.not.objectContaining({ cascadeTo: expect.anything() }), cwd);
    const { readEvents } = await import("../src/tasks/events.js");
    expect(readEvents(cwd).filter((event) => event.type === "cascade.hop")).toEqual([]);
  });

  it("keeps today's requeue/wait behavior when the ladder is exhausted", async () => {
    const cfg = { ...DEFAULT_CONFIG, tierMembers: { free: [], cheap: [], standard: [], lead: [{ agent: "codex" }] } };
    mocks.runTask.mockResolvedValue({ ok: false, outcome: "quota", code: 1, durationMs: 1, timedOut: false });
    const onCascade = vi.fn();
    expect((await processNext("codex", cfg, cwd, { onCascade }))?.outcome).toBe("requeued");
    expect(onCascade).not.toHaveBeenCalled();
    expect(mocks.editIssue).toHaveBeenLastCalledWith(35, { cwd, addLabels: ["status:todo"], removeLabels: ["status:claimed", "status:in-progress"] });
    expect(mocks.ensureLabels).not.toHaveBeenCalled();
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

    // Safe cleanup also lets a CLEAN worktree go when its commits live elsewhere (pushed branch, open PR),
    // so removeWorktree() succeeding proves nothing: the requeue must look for that work itself.
    it("does not requeue over commits the run pushed or submitted before dying, even though cleanup would succeed", async () => {
      mocks.runTask.mockImplementation(dies);
      mocks.removeWorktree.mockResolvedValue(true); // clean worktree, commits preserved on the remote branch
      mocks.countCommitsAhead.mockResolvedValue(2);

      expect(await processNext("codex", DEFAULT_CONFIG, cwd)).toMatchObject({ issue: 35, outcome: "failed" });
      expect(mocks.editIssue).not.toHaveBeenCalledWith(35, expect.objectContaining({ addLabels: ["status:todo"] }));
      expect(mocks.appendRun.mock.calls[0][0]).toMatchObject({ outcome: "failed" });
    });

    it.each([
      ["its task branch", { number: 90, headRefName: "task/35-recover-runner-failures", body: "" }],
      ["a Closes #35 line", { number: 91, headRefName: "feature/x", body: "Closes #35" }],
    ])("does not requeue a task that already has an open PR (matched by %s)", async (_how, pr) => {
      mocks.runTask.mockImplementation(dies);
      mocks.listOpenPrs.mockResolvedValue([pr]);

      expect(await processNext("codex", DEFAULT_CONFIG, cwd)).toMatchObject({ outcome: "failed" });
      expect(mocks.editIssue).not.toHaveBeenCalledWith(35, expect.objectContaining({ addLabels: ["status:todo"] }));
    });

    it("requeues when other tasks have open PRs but this one does not", async () => {
      mocks.runTask.mockImplementation(dies);
      mocks.listOpenPrs.mockResolvedValue([{ number: 92, headRefName: "task/36-other", body: "Closes #36" }]);

      expect(await processNext("codex", DEFAULT_CONFIG, cwd)).toMatchObject({ outcome: "requeued" });
    });

    it.each([
      ["the commit comparison", () => mocks.countCommitsAhead.mockRejectedValue(new Error("merge-base failed"))],
      ["the open-PR lookup", () => mocks.listOpenPrs.mockRejectedValue(new Error("gh unreachable"))],
    ])("fails closed (no requeue, nothing removed) when %s cannot be read", async (_name, arrange) => {
      mocks.runTask.mockImplementation(dies);
      arrange();

      expect(await processNext("codex", DEFAULT_CONFIG, cwd)).toMatchObject({ outcome: "failed" });
      expect(mocks.editIssue).not.toHaveBeenCalledWith(35, expect.objectContaining({ addLabels: ["status:todo"] }));
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

  it.each([false, true])("clears active labels after a failed implement (timedOut=%s)", async (timedOut) => {
    let labels = ["agent:codex", "status:claimed", "status:in-progress"];
    mocks.editIssue.mockImplementation(async (_n: number, edit: { addLabels?: string[]; removeLabels?: string[] }) => {
      labels = [...new Set([...labels.filter((label) => !edit.removeLabels?.includes(label)), ...(edit.addLabels ?? [])])];
    });
    mocks.runTask.mockResolvedValue({ ok: false, code: 1, durationMs: 1, timedOut });

    expect(await processNext("codex", DEFAULT_CONFIG, cwd)).toMatchObject({ outcome: "failed" });
    expect(labels).toEqual(["agent:codex", "needs-attention"]);
    expect(mocks.removeWorktree).toHaveBeenCalledOnce();
    expect(mocks.lockRelease).toHaveBeenCalledOnce();
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
