import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { RunContext, RunResult } from "../adapters/types.js";
import { makeAdapter } from "../adapters/index.js";
import { noteUsageLimitFromLog, unavailableUntil } from "../board/availability.js";
import { merge } from "../board/review.js";
import { NoReviewerError, runAutomatedReview } from "../board/review-run.js";
import type { RunPhase } from "../board/telemetry.js";
import type { OrchConfig } from "../config.js";
import { resolveBaseBranch } from "../git/git.js";
import { observeWorktree } from "../git/worktree.js";
import { commentOnPr, editIssue, failingChecks } from "../github/github.js";
import { NEEDS_ATTENTION, REVIEWED_BY_PREFIX, REVIEW_NEEDED, STATUS } from "../github/labels.js";
import { exec } from "../util/exec.js";
import { log } from "../util/log.js";
import { logSize, readLogSince } from "../util/log-file.js";
import type { TaskObservation } from "./observe.js";
import { formatConflictPrompt, formatFixPrompt } from "./step-prompts.js";
import { readSession, writeSession } from "./sessions.js";
import { recordRun, resolveTaskModel } from "./runner.js";

/** The outcome of one step. The coordinator logs it and re-observes; it never trusts it as state. */
export type Signal =
  | "review.approved"
  | "review.changes_requested"
  | "fix.pushed"
  | "conflict.resolved"
  | "task.merged"
  | "task.escalated"
  | "agent.unavailable"
  | "step.failed";

export interface StepResult {
  signal: Signal;
  detail?: string;
}

/** The I/O an executor needs beyond GitHub: tests substitute these, production uses the real ones. */
export interface StepEnv {
  runAgent(ctx: RunContext): Promise<RunResult>;
  git(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }>;
}

export function defaultEnv(cfg: OrchConfig): StepEnv {
  return {
    runAgent: (ctx) => makeAdapter(ctx.agent, cfg).runTask(ctx),
    git: (args, cwd) => exec("git", args, { cwd }),
  };
}

function failure(detail: string): StepResult {
  return { signal: "step.failed", detail };
}

/** One agent run plus the log text that run itself produced (see `util/log-file.ts`). */
interface TrackedRun {
  run: RunResult;
  /** Only what this invocation appended: an earlier attempt's events must never be mistaken for it. */
  logText: string;
  logFile: string;
  /** Log size just before the run, so telemetry can read this run's range and nothing else. */
  since: number;
}

async function runTracked(env: StepEnv, ctx: RunContext): Promise<TrackedRun> {
  const logFile = ctx.logFile ?? "";
  const since = logFile ? logSize(logFile) : 0;
  const run = await env.runAgent(ctx);
  return { run, logText: logFile ? readLogSince(logFile, since) : "", logFile, since };
}

/** A harness failure that was really a usage limit pauses that harness instead of failing the task. */
function afterAgentFailure(agent: string, attempt: TrackedRun, cwd: string): StepResult {
  const until = noteUsageLimitFromLog(agent, attempt.logText, cwd);
  if (until) return { signal: "agent.unavailable", detail: `'${agent}' is out of usage until ${until.toISOString()}` };
  const { run } = attempt;
  return failure(run.timedOut ? `'${agent}' timed out` : `'${agent}' exited ${run.code}`);
}

/** Review the current head headlessly and record the verdict. */
export async function executeReview(obs: TaskObservation, cfg: OrchConfig, cwd: string): Promise<StepResult> {
  try {
    const out = await runAutomatedReview(obs.pr.number, cfg, cwd);
    return {
      signal: out.decision === "approve" ? "review.approved" : "review.changes_requested",
      detail: `${out.reviewer} (${out.mode})`,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return error instanceof NoReviewerError ? { signal: "agent.unavailable", detail } : failure(detail);
  }
}

interface WorktreeState {
  head: string;
  dirty: boolean;
}

async function inspectWorktree(env: StepEnv, worktree: string): Promise<WorktreeState> {
  const head = await env.git(["rev-parse", "HEAD"], worktree);
  if (head.code !== 0) throw new Error(`git rev-parse failed: ${head.stderr.trim()}`);
  const status = await env.git(["status", "--porcelain"], worktree);
  if (status.code !== 0) throw new Error(`git status failed: ${status.stderr.trim()}`);
  return { head: head.stdout.trim(), dirty: status.stdout.trim().length > 0 };
}

/**
 * Push the worktree's commits to the PR branch (never forced) and put the task back in
 * review. Requires that the agent actually moved HEAD and left nothing uncommitted.
 */
async function pushAndRequeueReview(
  obs: TaskObservation,
  env: StepEnv,
  cwd: string,
  worktree: string,
  extraCheck?: () => Promise<string | null>,
): Promise<StepResult | null> {
  const state = await inspectWorktree(env, worktree);
  if (state.dirty) return failure("the agent left uncommitted changes; nothing was pushed");
  if (state.head === obs.pr.headSha) return failure("the agent made no new commits");
  const problem = await extraCheck?.();
  if (problem) return failure(problem);

  const push = await env.git(["push", "origin", `HEAD:refs/heads/${obs.pr.headRefName}`], worktree);
  if (push.code !== 0) return failure(`git push failed: ${push.stderr.trim()}`);
  await editIssue(obs.issue.number, {
    cwd,
    addLabels: [STATUS.inReview, REVIEW_NEEDED],
    // A new head voids earlier approvals, so their projections go too (the gate never reads them).
    removeLabels: [STATUS.inProgress, ...obs.issue.labels.filter((l) => l.startsWith(REVIEWED_BY_PREFIX))],
  });
  return null; // pushed
}

/**
 * Prove the task worktree is the one this PR was built in before a writable harness touches it
 * or anything is pushed from it. "A directory exists" is not enough: a switched, detached, or
 * unregistered worktree could contribute unrelated commits to the PR branch. Git must register
 * the path on the expected task branch (`observeWorktree`), that branch must be the PR's, and the
 * PR head must already be part of its history so that pushing is a plain fast-forward.
 */
async function resolveWorktree(
  obs: TaskObservation,
  cfg: OrchConfig,
  cwd: string,
  env: StepEnv,
): Promise<{ path: string } | { problem: string }> {
  const n = obs.issue.number;
  const repair = `run \`orch repair ${n}\``;
  const seen = await observeWorktree(n, obs.issue.title, cfg.worktreeRoot, { cwd });
  if (seen.outcome === "absent") return { problem: `the task worktree for #${n} is missing; ${repair}` };
  if (seen.outcome !== "usable") return { problem: `the task worktree for #${n} is not usable (${seen.detail}); ${repair}` };

  const { path, branch } = seen.worktree;
  if (branch !== obs.pr.headRefName) {
    return { problem: `the task worktree is on '${branch}' but PR #${obs.pr.number} is '${obs.pr.headRefName}'; refusing to edit or push` };
  }
  await env.git(["fetch", "origin", obs.pr.headRefName], path); // best-effort: makes the PR head object available locally
  const contains = await env.git(["merge-base", "--is-ancestor", obs.pr.headSha, "HEAD"], path);
  if (contains.code !== 0) {
    return { problem: `the task worktree does not contain PR head ${obs.pr.headSha.slice(0, 8)}; refusing to edit or push` };
  }
  return { path };
}

function followUpLog(cwd: string, issue: number, tag: string): string {
  const dir = resolve(cwd, "logs");
  mkdirSync(dir, { recursive: true });
  return resolve(dir, `issue-${issue}-${tag}.jsonl`);
}

/**
 * Send review feedback or a red CI back to the author. Resumes the author's own conversation when
 * one is on record (falling back to a fresh, fully-briefed session if the harness refuses it),
 * then pushes the new commits and returns the task to review.
 */
export async function executeFix(
  obs: TaskObservation,
  reason: "review" | "ci",
  cfg: OrchConfig,
  cwd: string,
  env: StepEnv = defaultEnv(cfg),
): Promise<StepResult> {
  const n = obs.issue.number;
  const agent = obs.author;
  const pausedUntil = unavailableUntil(agent, cwd);
  if (pausedUntil) return { signal: "agent.unavailable", detail: `'${agent}' is paused until ${pausedUntil.toISOString()}` };
  const found = await resolveWorktree(obs, cfg, cwd, env);
  if ("problem" in found) return failure(found.problem);
  const worktree = found.path;

  const base = await resolveBaseBranch(cfg.baseBranch, cwd);
  const failing = reason === "ci" ? await failingChecks(obs.pr.number, { cwd }) : [];
  const round = obs.facts.rounds + 1;
  const model = resolveTaskModel(agent, obs.issue, cfg);
  const prompt = (resumed: boolean): string =>
    formatFixPrompt({
      issue: obs.issue, pr: obs.pr, worktree, reason, notes: obs.feedback, failingChecks: failing,
      resumed, baseName: base.name,
    });

  const session = readSession(n, cwd);
  let resume = session && session.agent === agent ? session.sessionId : undefined;
  let started = Date.now();
  let attempt = await runTracked(env, {
    issue: n, agent, worktree, prompt: prompt(resume !== undefined), model, logFile: followUpLog(cwd, n, `fix${round}`),
    timeoutMs: cfg.taskTimeoutMs, resumeSession: resume,
  });
  if (!attempt.run.ok && resume !== undefined && !noteUsageLimitFromLog(agent, attempt.logText, cwd)) {
    // The harness could not resume (expired/foreign session): continue from durable facts instead.
    log.warn(`#${n}: resuming '${agent}' session failed (exit ${attempt.run.code}); retrying with a fresh session`);
    resume = undefined;
    // The failed resume still cost something: record it as its own run before the fresh attempt.
    recordRun(n, agent, model, "fix-resume-failed", Date.now() - started, attempt.logFile, cwd, cfg,
      { phase: "fix" satisfies RunPhase, round, since: attempt.since });
    started = Date.now();
    attempt = await runTracked(env, {
      issue: n, agent, worktree, prompt: prompt(false), model, logFile: followUpLog(cwd, n, `fix${round}-cold`),
      timeoutMs: cfg.taskTimeoutMs,
    });
  }
  const run = attempt.run;
  const outcome = async (): Promise<StepResult> => {
    if (!run.ok) return afterAgentFailure(agent, attempt, cwd);
    if (run.sessionId) writeSession(n, { agent, sessionId: run.sessionId }, cwd);
    return (await pushAndRequeueReview(obs, env, cwd, worktree)) ?? { signal: "fix.pushed", detail: `round ${round} (${reason})` };
  };
  const result = await outcome();
  recordRun(n, agent, model, result.signal === "fix.pushed" ? "fix-pushed" : "fix-failed", Date.now() - started,
    attempt.logFile, cwd, cfg, { phase: "fix" satisfies RunPhase, round, since: attempt.since });
  return result;
}

/** Prefer Claude for conflict resolution (per project policy), else the author, else wait. */
export function pickResolver(author: string, cfg: OrchConfig, cwd: string): string | null {
  const preferred = ["claude", author].filter((a, i, all) => cfg.agents.includes(a) && all.indexOf(a) === i);
  return preferred.find((a) => unavailableUntil(a, cwd) === null) ?? null;
}

/** Merge the moved base into a conflicting PR branch with an agent, then push and re-review. */
export async function executeResolveConflict(
  obs: TaskObservation,
  cfg: OrchConfig,
  cwd: string,
  env: StepEnv = defaultEnv(cfg),
): Promise<StepResult> {
  const n = obs.issue.number;
  const agent = pickResolver(obs.author, cfg, cwd);
  if (!agent) return { signal: "agent.unavailable", detail: "no harness is available to resolve the conflict" };
  const found = await resolveWorktree(obs, cfg, cwd, env);
  if ("problem" in found) return failure(found.problem);
  const worktree = found.path;

  const base = await resolveBaseBranch(cfg.baseBranch, cwd);
  const fetch = await env.git(["fetch", "origin", base.name], worktree);
  if (fetch.code !== 0) return failure(`git fetch failed: ${fetch.stderr.trim()}`);

  const round = obs.facts.rounds + 1;
  const model = resolveTaskModel(agent, obs.issue, cfg);
  const logFile = followUpLog(cwd, n, `resolve${round}`);
  const started = Date.now();
  const attempt = await runTracked(env, {
    issue: n, agent, worktree, model, logFile, timeoutMs: cfg.taskTimeoutMs,
    prompt: formatConflictPrompt({ issue: obs.issue, pr: obs.pr, worktree, baseName: base.name }),
  });
  const run = attempt.run;
  const result = run.ok
    ? ((await pushAndRequeueReview(obs, env, cwd, worktree, async () => {
        const merged = await env.git(["merge-base", "--is-ancestor", `origin/${base.name}`, "HEAD"], worktree);
        return merged.code === 0 ? null : `the branch still does not contain origin/${base.name}`;
      })) ?? ({ signal: "conflict.resolved", detail: `resolved by '${agent}'` } satisfies StepResult))
    : afterAgentFailure(agent, attempt, cwd);
  recordRun(n, agent, model, result.signal === "conflict.resolved" ? "resolve-pushed" : "resolve-failed",
    Date.now() - started, attempt.logFile, cwd, cfg, { phase: "resolve-conflict", round, since: attempt.since });
  return result;
}

/** Merge through the full gate (approval, CI, head guard). A refusal is a failure, not a bypass. */
export async function executeMerge(obs: TaskObservation, cfg: OrchConfig, cwd: string): Promise<StepResult> {
  try {
    await merge(obs.pr.number, cfg, cwd, false);
    return { signal: "task.merged", detail: `PR #${obs.pr.number}` };
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}

/** Hand the task to a human: label it and say why on the PR. The loop then leaves it alone. */
export async function executeEscalate(obs: TaskObservation, reason: string, cwd: string): Promise<StepResult> {
  await editIssue(obs.issue.number, { cwd, addLabels: [NEEDS_ATTENTION] });
  try {
    await commentOnPr(
      obs.pr.number,
      `**orch autopilot stopped on #${obs.issue.number}.** ${reason}.\n\n` +
        "A human needs to decide what happens next. Remove the `needs-attention` label to hand the task back to the loop.",
      { cwd },
    );
  } catch (error) {
    log.warn(`#${obs.issue.number}: escalated but could not comment: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { signal: "task.escalated", detail: reason };
}
