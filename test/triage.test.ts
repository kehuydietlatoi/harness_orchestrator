import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type OrchConfig } from "../src/config.js";
import { formatReview } from "../src/board/approval.js";
import { markUnavailable } from "../src/board/availability.js";
import { readRuns } from "../src/board/telemetry.js";
import type { HeadlessResult } from "../src/adapters/headless.js";
import { executeTriage, type StepResult, type TriageEnv } from "../src/tasks/step-exec.js";
import type { TaskObservation } from "../src/tasks/observe.js";
import { formatFixPrompt } from "../src/tasks/step-prompts.js";
import {
  formatTriageComment, formatTriagePrompt, parseTriageComment, parseTriageDecision, triageFacts, type TriageRecord,
} from "../src/tasks/triage.js";

const HEAD = "a".repeat(40);
const record = (over: Partial<TriageRecord> = {}): TriageRecord => ({
  pr: 62, head: HEAD, timestamp: "2026-10-07T00:00:00Z", decision: "retry", extraRounds: 1, ...over,
});

describe("triage record", () => {
  it("round-trips through a PR comment, with guidance as the last section", () => {
    const body = formatTriageComment(record({ effort: "hard" }), { issue: 38, reason: "CI is still failing", text: "Fix the flaky test --> properly." });
    expect(body).toContain("Decision: one more fix round, on the hard model tier.");
    const parsed = parseTriageComment({ body });
    expect(parsed?.record).toEqual(record({ effort: "hard" }));
    expect(triageFacts([{ id: 1, body }], 62, 1)).toEqual({ triages: 1, extraRounds: 1, guidance: "Fix the flaky test --> properly." });
  });

  it("rejects malformed or inconsistent records", () => {
    const bad = (r: object) => parseTriageComment({ body: `x\n<!-- orch-triage:v1 ${JSON.stringify(r)} -->` });
    expect(bad(record({ head: "nope" }))).toBeNull();
    expect(bad(record({ extraRounds: 0 }))).toBeNull(); // a retry always grants exactly one round
    expect(bad(record({ decision: "escalate", extraRounds: 1 }))).toBeNull();
    expect(bad({ ...record(), effort: "easy" })).toBeNull();
    expect(bad({ ...record(), pr: "62" })).toBeNull();
    expect(parseTriageComment({ body: "<!-- orch-triage:v1 {not json} -->" })).toBeNull();
    expect(parseTriageComment({ body: "plain comment" })).toBeNull();
  });

  it("counts only this PR's records and caps granted rounds at the triage budget", () => {
    const retry = (id: number, pr = 62) => ({ id, body: formatTriageComment(record({ pr }), { issue: 38, reason: "r", text: `g${id}` }) });
    expect(triageFacts([retry(1), retry(2, 99)], 62, 1)).toEqual({ triages: 1, extraRounds: 1, guidance: "g1" });
    // Forged extra records cannot buy more rounds than the budget allows.
    expect(triageFacts([retry(1), retry(2), retry(3)], 62, 1)).toMatchObject({ triages: 3, extraRounds: 1, guidance: "g3" });
    expect(triageFacts([retry(1)], 62, 0).extraRounds).toBe(0);
  });
});

describe("parseTriageDecision", () => {
  it("accepts exactly one well-formed retry or escalation", () => {
    expect(parseTriageDecision('```json\n{"decision":"retry","guidance":" do X "}\n```')).toEqual({ decision: "retry", guidance: "do X" });
    expect(parseTriageDecision('```json\n{"decision":"retry","guidance":"do X","effort":"hard"}\n```'))
      .toEqual({ decision: "retry", guidance: "do X", effort: "hard" });
    expect(parseTriageDecision('```json\n{"decision":"escalate","diagnosis":"spec conflict","question":"which API?"}\n```'))
      .toEqual({ decision: "escalate", diagnosis: "spec conflict", question: "which API?" });
  });

  it("fails closed on anything else", () => {
    for (const reply of [
      "no block at all",
      '```json\n{"decision":"retry"}\n```',
      '```json\n{"decision":"retry","guidance":"   "}\n```',
      '```json\n{"decision":"retry","guidance":"x","effort":"easy"}\n```',
      '```json\n{"decision":"escalate"}\n```',
      '```json\n{"decision":"merge"}\n```',
      '```json\n["retry"]\n```',
      "```json\n{oops}\n```",
    ]) {
      expect(parseTriageDecision(reply), reply).toBeNull();
    }
  });
});

describe("triage and fix prompts", () => {
  it("gives the lead the reason, review history, changed files, spec, and the contract", () => {
    const prompt = formatTriagePrompt({
      issue: { number: 38, title: "Add SSO", body: "Spec body\n\n<details><summary>Plan context</summary>why</details>" },
      pr: { number: 62, headSha: HEAD, headRefName: "task/38-sso" },
      author: "codex", effort: "easy", reason: "review feedback is still unresolved after 3 fix rounds (limit 3)",
      checks: "pass", mergeable: "clean",
      reviews: [{ id: 1, state: "COMMENTED", commit_id: HEAD, body: formatReview({ reviewer: "claude", pr: 62, head: HEAD, timestamp: "2026-10-07T00:00:00Z", decision: "request-changes" }, "rename the module") }],
      files: [{ path: "src/sso.ts", status: "added", binary: false, additions: 40, deletions: 0 }],
    });
    for (const part of ["after 3 fix rounds", "claude requested changes on aaaaaaaa", "rename the module", "src/sso.ts (added, +40/-0)",
      "Plan context", "on the easy tier", "spawn sub-agents", '"decision": "retry"', '"decision": "escalate"']) {
      expect(prompt, part).toContain(part);
    }
  });

  it("puts the lead's guidance in the fix prompt only when there is some", () => {
    const base = {
      issue: { number: 38, title: "t", body: "spec" }, pr: { number: 62, headRefName: "task/38-x" }, worktree: "/wt",
      reason: "review" as const, notes: "fix it", failingChecks: [], resumed: true, baseName: "main",
    };
    expect(formatFixPrompt({ ...base, leadGuidance: "Decline the rename." })).toMatch(/## Guidance from the lead[\s\S]*Decline the rename\./);
    expect(formatFixPrompt({ ...base, leadGuidance: null })).not.toContain("Guidance from the lead");
  });
});

describe("executeTriage", () => {
  let home = "";
  let cwd = "";
  const previousHome = process.env.ORCH_HOME;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "orch-triage-home-"));
    cwd = mkdtempSync(join(tmpdir(), "orch-triage-repo-"));
    process.env.ORCH_HOME = home;
  });
  afterEach(() => {
    process.env.ORCH_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  const cfg: OrchConfig = { ...DEFAULT_CONFIG, lead: "claude" };
  function obs(labels: string[] = ["agent:codex", "effort:easy"]): TaskObservation {
    return {
      issue: { number: 38, title: "t", body: "spec", state: "OPEN", labels, assignees: [] },
      author: "codex",
      pr: { number: 62, title: "", body: "", state: "OPEN", headSha: HEAD, headRefName: "task/38-x", htmlUrl: "" },
      reviews: [],
      facts: {
        attention: false, pr: { number: 62, head: HEAD, checks: "pass", mergeable: "clean" },
        review: { approved: false, changesRequested: true }, rounds: 3, maxRounds: 3, requireHumanMerge: false,
        triages: 0, maxTriages: 1, extraRounds: 0,
      },
      step: { kind: "triage", reason: "stuck" },
      feedback: "fix it",
    } as TaskObservation;
  }

  function env(reply: Partial<HeadlessResult>, over: Partial<TriageEnv> = {}) {
    const calls: string[] = [];
    const comments: string[] = [];
    const e: TriageEnv = {
      runLead: async ({ model, pr }) => {
        calls.push(`lead:${model?.model}:${pr.headSha.slice(0, 4)}`);
        return { code: 0, timedOut: false, text: "", raw: "", ...reply };
      },
      changedFiles: async () => [],
      headOf: async () => HEAD,
      comment: async (_pr, body) => { comments.push(body); },
      setHardEffort: async (issue, from) => { calls.push(`effort:${issue}:${from}`); },
      escalate: async (_obs, reason): Promise<StepResult> => { calls.push(`escalate:${reason}`); return { signal: "task.escalated", detail: reason }; },
      now: () => new Date("2026-10-07T00:00:00Z"),
      ...over,
    };
    return { e, calls, comments };
  }

  it("grants one more round on a retry, records it, and moves an easy task to the hard tier when asked", async () => {
    const { e, calls, comments } = env({ text: '```json\n{"decision":"retry","guidance":"Decline the rename.","effort":"hard"}\n```' });
    const result = await executeTriage(obs(), "stuck", cfg, cwd, e);

    expect(result).toEqual({ signal: "triage.retry", detail: "one more round on the hard tier" });
    expect(calls).toEqual(["lead:claude-opus-5-5:aaaa", "effort:38:easy"]);
    expect(parseTriageComment({ body: comments[0] })?.record).toMatchObject({ decision: "retry", extraRounds: 1, effort: "hard", head: HEAD });
    expect(readRuns(cwd).at(-1)).toMatchObject({ phase: "triage", agent: "claude", outcome: "triage-retry", issue: 38 });
  });

  it("does not move a task that is already on the hard tier", async () => {
    const { e, calls, comments } = env({ text: '```json\n{"decision":"retry","guidance":"g","effort":"hard"}\n```' });
    expect((await executeTriage(obs(["agent:codex", "effort:hard"]), "stuck", cfg, cwd, e)).detail).toBe("one more round");
    expect(calls.some((c) => c.startsWith("effort:"))).toBe(false);
    expect(parseTriageComment({ body: comments[0] })?.record.effort).toBeUndefined();
  });

  it("escalates with the lead's diagnosis and question, recording the decision", async () => {
    const { e, calls, comments } = env({ text: '```json\n{"decision":"escalate","diagnosis":"The spec contradicts itself.","question":"Keep v1?"}\n```' });
    const result = await executeTriage(obs(), "stuck", cfg, cwd, e);

    expect(result.signal).toBe("task.escalated");
    expect(calls.at(-1)).toBe("escalate:stuck. Lead triage: The spec contradicts itself. Question for you: Keep v1?");
    expect(parseTriageComment({ body: comments[0] })?.record).toMatchObject({ decision: "escalate", extraRounds: 0 });
  });

  it("fails closed to a human on an unparseable reply, a failed run, or a crash", async () => {
    for (const [reply, over, expected] of [
      [{ text: "I think you should retry" }, {}, /lead triage failed \(gave no valid decision\)/],
      [{ code: 1 }, {}, /lead triage failed \(exited 1\)/],
      [{ timedOut: true }, {}, /lead triage failed \(timed out\)/],
      [{}, { runLead: async () => { throw new Error("no checkout"); } }, /lead triage failed \(no checkout\)/],
    ] as const) {
      const { e, calls } = env(reply, over);
      expect((await executeTriage(obs(), "stuck", cfg, cwd, e)).signal).toBe("task.escalated");
      expect(calls.at(-1)).toMatch(expected);
    }
  });

  it("escalates at once without running when the lead is paused", async () => {
    markUnavailable("claude", { resetAt: new Date("2099-01-01T00:00:00Z"), reason: "limit" }, cwd);
    const paused = env({});
    await executeTriage(obs(), "stuck", cfg, cwd, paused.e);
    expect(paused.calls).toEqual([expect.stringMatching(/^escalate:stuck; lead triage was unavailable/)]);
  });

  it("pauses a lead that hits its usage limit mid-triage, and still hands the task to a human", async () => {
    const limited = env({
      code: 1,
      raw: '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":4102444800,"rateLimitType":"five_hour"}}',
    });
    await executeTriage(obs(), "stuck", cfg, cwd, limited.e);
    expect(limited.calls.at(-1)).toMatch(/^escalate:stuck; lead triage was unavailable: 'claude' hit its usage limit/);
    // The lead is now on cooldown: the next triage does not even start a run.
    const next = env({});
    await executeTriage(obs(), "stuck", cfg, cwd, next.e);
    expect(next.calls.some((c) => c.startsWith("lead:"))).toBe(false);
  });

  it("refuses to record a retry on a head that moved during triage, and fails when the record cannot be written", async () => {
    const moved = env({ text: '```json\n{"decision":"retry","guidance":"g"}\n```' }, { headOf: async () => "b".repeat(40) });
    expect(await executeTriage(obs(), "stuck", cfg, cwd, moved.e)).toMatchObject({ signal: "step.failed" });
    expect(moved.comments).toEqual([]);

    const unwritable = env({ text: '```json\n{"decision":"retry","guidance":"g"}\n```' }, { comment: async () => { throw new Error("gh down"); } });
    expect(await executeTriage(obs(), "stuck", cfg, cwd, unwritable.e)).toMatchObject({ signal: "step.failed", detail: expect.stringMatching(/gh down/) });
  });
});
