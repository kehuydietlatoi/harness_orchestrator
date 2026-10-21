import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { executeObserve, type ObserveEnv } from "../src/tasks/step-exec.js";
import { observeTasks, type TaskObservation } from "../src/tasks/observe.js";
import { formatObserveComment, newestObserveRecord, observeRecordFact, type ObserveRecord } from "../src/tasks/observe-record.js";
import { renderTicketV2 } from "../src/tasks/ticket-metadata.js";
import type { Board } from "../src/github/board.js";
import { formatFixPrompt } from "../src/tasks/step-prompts.js";

const sha = "a".repeat(40);
const issue = { number: 218, title: "Observe", body: "## Definition of done\n- Observe: button is visible\n\n" + renderTicketV2({ observe: ["menu"] }), state: "OPEN", labels: ["agent:claude"], assignees: [] };
const pr = { number: 300, headSha: sha, headRefName: "task/218", title: "Observe", body: "Closes #218", state: "OPEN", htmlUrl: "" };
const obs: TaskObservation = { issue, pr, author: "claude", reviews: [], feedback: null, facts: {
  attention: false, pr: { number: 300, head: sha, checks: "pass", mergeable: "clean" },
  review: { approved: false, changesRequested: false }, rounds: 0, maxRounds: 3, requireHumanMerge: false,
}, step: { kind: "observe" } };
const record: ObserveRecord = { pr: 300, sha, overall: "verified", lines: [{ acceptance: "Observe: button is visible", verdict: "verified", evidence: ["shots/menu.png"], note: "Visible" }], concerns: [] };
const recordedAt = "2026-10-20T10:00:00Z";
const comment = (r = record, id = 1, created_at = recordedAt) => ({ id, created_at, body: formatObserveComment(r, ["evidence/menu"]) });

function fake() {
  const release = vi.fn(async () => {});
  const evidence = vi.fn<ObserveEnv["evidence"]>().mockResolvedValue({ checkout: { path: "checkout", release }, results: [{ scenario: "menu", status: "ok", outDir: "evidence/menu", durationMs: 1 }] });
  const judge = vi.fn<ObserveEnv["judge"]>().mockResolvedValue({ kind: "verdict", judge: "codex", verdict: { ...record, gate: "observe" } });
  const env: ObserveEnv = { evidence, judge, headOf: vi.fn(async () => sha), status: vi.fn(async () => {}), comment: vi.fn(async () => {}) };
  return { env, release, evidence, judge };
}

describe("executeObserve", () => {
  it("writes verified success and a verdict table, then releases", async () => {
    const { env, release, judge } = fake();
    expect(await executeObserve(obs, DEFAULT_CONFIG, ".", env)).toMatchObject({ signal: "observe.finished" });
    expect(env.status).toHaveBeenCalledWith(sha, "success", "verified");
    expect(env.comment).toHaveBeenCalledWith(300, expect.stringContaining("| Acceptance | Verdict | Evidence | Note |"));
    expect(judge.mock.calls[0][0].acceptance).toEqual(["Observe: button is visible"]);
    expect(release).toHaveBeenCalledOnce();
  });
  it("records evidence failure without invoking the judge", async () => {
    const { env, release, evidence, judge } = fake();
    evidence.mockResolvedValue({ checkout: { path: "checkout", release }, results: [{ scenario: "menu", status: "failed", error: "browser crashed", outDir: "evidence/menu", durationMs: 1 }] });
    await executeObserve(obs, DEFAULT_CONFIG, ".", env);
    expect(judge).not.toHaveBeenCalled();
    expect(env.status).toHaveBeenCalledWith(sha, "failure", "verifier-blocked");
    expect(env.comment).toHaveBeenCalledWith(300, expect.stringContaining("browser crashed"));
    expect(release).toHaveBeenCalledOnce();
  });
  it("writes nothing when the head moved and still releases", async () => {
    const { env, release } = fake();
    env.headOf = async () => "b".repeat(40);
    expect(await executeObserve(obs, DEFAULT_CONFIG, ".", env)).toMatchObject({ signal: "step.failed" });
    expect(env.status).not.toHaveBeenCalled();
    expect(env.comment).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });
  it("records an unavailable judge as blocked", async () => {
    const { env, judge, release } = fake();
    judge.mockResolvedValue({ kind: "NoObserveJudge", reason: "no vision-capable judge of another family" });
    await executeObserve(obs, DEFAULT_CONFIG, ".", env);
    expect(env.status).toHaveBeenCalledWith(sha, "failure", "verifier-blocked");
    expect(env.comment).toHaveBeenCalledWith(300, expect.stringContaining("no vision-capable judge of another family"));
    expect(release).toHaveBeenCalledOnce();
  });
  it("releases even when publishing fails", async () => {
    const { env, release } = fake();
    env.status = async () => { throw new Error("offline"); };
    expect(await executeObserve(obs, DEFAULT_CONFIG, ".", env)).toMatchObject({ signal: "step.failed" });
    expect(release).toHaveBeenCalledOnce();
  });
});

describe("observe record and observation", () => {
  it("reads only the newest matching PR/head and escapes marker delimiters", () => {
    const r = { ...record, concerns: ["text --> <danger>"] };
    expect(newestObserveRecord([comment(r)], 300, sha)).toEqual(r);
    expect(newestObserveRecord([comment()], 300, "b".repeat(40))).toBeNull();
    expect(newestObserveRecord([comment()], 301, sha)).toBeNull();
    const newer = { ...record, overall: "not-verified" as const };
    expect(newestObserveRecord([comment(), comment(newer, 2)], 300, sha)).toEqual(newer);
    expect(observeRecordFact(null, record).state).toBe("missing");
    expect(observeRecordFact("success", null).state).toBe("missing");
  });
  function board(): Board {
    return { listIssues: vi.fn(async () => [issue]), listOpenPrs: vi.fn(async () => [pr]), listPrReviews: vi.fn(async () => []),
      prChecksState: vi.fn(async () => "pass"), prMergeability: vi.fn(async () => "clean"),
      observeStatus: vi.fn(async () => "success"), listPrComments: vi.fn(async () => [comment()]),
      latestLabelRemoval: vi.fn(async () => null),
      editIssue: vi.fn(), closeIssue: vi.fn(), commentOnPr: vi.fn() };
  }
  it("counts only the newest consecutive not-verified records for this PR and head", async () => {
    const b = board();
    const rejected = { ...record, overall: "not-verified" as const };
    b.observeStatus = async () => "failure";
    b.listPrComments = async () => [comment(rejected), comment(rejected, 2),
      comment({ ...rejected, sha: "b".repeat(40) }, 3), comment({ ...rejected, pr: 301 }, 4),
      { id: 5, created_at: recordedAt, body: '<!-- orch-observe:v1 {broken} -->' }];
    expect((await observeTasks(DEFAULT_CONFIG, ".", {}, b)).tasks[0].facts.observeNotVerifiedCount).toBe(2);
    b.listPrComments = async () => [comment(rejected), comment(record, 2), comment(rejected, 3)];
    expect((await observeTasks(DEFAULT_CONFIG, ".", {}, b)).tasks[0].facts.observeNotVerifiedCount).toBe(1);
    b.listPrComments = async () => [comment(rejected), comment({ ...rejected, evidenceError: "capture failed" }, 2), comment(rejected, 3)];
    expect((await observeTasks(DEFAULT_CONFIG, ".", {}, b)).tasks[0].facts.observeNotVerifiedCount).toBe(1);
    b.observeStatus = async () => "success";
    b.listPrComments = async () => [comment(record)];
    expect((await observeTasks(DEFAULT_CONFIG, ".", {}, b)).tasks[0].facts.observeNotVerifiedCount).toBeUndefined();
  });
  it("uses current-head status and comment; older verified records are missing", async () => {
    const b = board();
    expect((await observeTasks(DEFAULT_CONFIG, ".", {}, b)).tasks[0].facts.observe?.state).toBe("verified");
    b.listPrComments = async () => [comment({ ...record, sha: "b".repeat(40) })];
    expect((await observeTasks(DEFAULT_CONFIG, ".", {}, b)).tasks[0].step.kind).toBe("observe");
  });
  it.each(["verifier-blocked", "inconclusive"] as const)("reruns %s once on the same SHA after handback", async overall => {
    const b = board();
    const blocked = { ...record, overall };
    b.observeStatus = async () => "failure";
    b.listPrComments = async () => [comment(blocked)];
    b.latestLabelRemoval = vi.fn(async () => "2026-10-20T11:00:00Z");
    const task = (await observeTasks(DEFAULT_CONFIG, ".", {}, b)).tasks[0];
    expect(task.facts.observe?.state).toBe("missing");
    expect(task.step.kind).toBe("observe");
    expect(task.pr.headSha).toBe(sha);
    expect(b.latestLabelRemoval).toHaveBeenCalledWith(issue.number, "needs-attention", { cwd: "." });
    // A fresh blocked result consumes that handback without a new commit.
    b.listPrComments = async () => [comment(blocked), comment(blocked, 2, "2026-10-20T12:00:00Z")];
    const rerun = (await observeTasks(DEFAULT_CONFIG, ".", {}, b)).tasks[0];
    expect(rerun.facts.observe?.state).toBe("blocked");
    expect(rerun.step.kind).toBe("escalate");
  });
  it.each([null, "2026-10-20T09:00:00Z", recordedAt])("keeps blocked without a strictly later handback (%s)", async removedAt => {
    const b = board();
    b.observeStatus = async () => "failure";
    b.listPrComments = async () => [comment({ ...record, overall: "verifier-blocked", evidenceError: "setup failed" })];
    b.latestLabelRemoval = vi.fn(async () => removedAt);
    const task = (await observeTasks(DEFAULT_CONFIG, ".", {}, b)).tasks[0];
    expect(task.facts.observe?.state).toBe("blocked");
    expect(task.step.kind).toBe("escalate");
  });
  it("leaves blocked PRs unobserved when handback events cannot be read", async () => {
    const b = board();
    b.observeStatus = async () => "failure";
    b.listPrComments = async () => [comment({ ...record, overall: "verifier-blocked" })];
    b.latestLabelRemoval = async () => { throw new Error("offline"); };
    const seen = await observeTasks(DEFAULT_CONFIG, ".", {}, b);
    expect(seen.tasks).toEqual([]);
    expect(seen.unobserved).toEqual([300]);
  });
  it("reads no handback events for verified, not-verified, missing or stale records", async () => {
    for (const overall of ["verified", "not-verified", "missing", "stale"] as const) {
      const b = board();
      b.observeStatus = async () => overall === "verified" ? "success" : "failure";
      b.listPrComments = async () => overall === "missing" ? [] : [comment({ ...record,
        overall: overall === "stale" ? "verifier-blocked" : overall,
        sha: overall === "stale" ? "b".repeat(40) : sha })];
      await observeTasks(DEFAULT_CONFIG, ".", {}, b);
      expect(b.latestLabelRemoval).not.toHaveBeenCalled();
    }
  });
  it("unreadable status or comments makes the PR unobserved", async () => {
    for (const key of ["observeStatus", "listPrComments"] as const) {
      const b = board(); b[key] = async () => { throw new Error("offline"); };
      const seen = await observeTasks(DEFAULT_CONFIG, ".", {}, b);
      expect(seen.tasks).toEqual([]); expect(seen.unobserved).toEqual([300]);
    }
  });
  it("does not read observe data on ordinary tickets", async () => {
    const b = board(); b.listIssues = async () => [{ ...issue, body: "" }];
    await observeTasks(DEFAULT_CONFIG, ".", {}, b);
    expect(b.observeStatus).not.toHaveBeenCalled(); expect(b.listPrComments).not.toHaveBeenCalled();
  });
  it("gives observe feedback to the author", () => {
    expect(formatFixPrompt({ issue, pr, worktree: ".", reason: "observe", notes: "Observe: button is visible: not-verified\nClipped at bottom", failingChecks: [], resumed: true, baseName: "main" })).toContain("Clipped at bottom");
  });
});
