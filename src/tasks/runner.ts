import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import pc from "picocolors";
import { formatModelSpec, type ModelSpec, type OrchConfig } from "../config.js";
import { claimNext, claimSpecific, submit, type ClaimedTask } from "./service.js";
import { buildBrief } from "./brief.js";
import { makeAdapter } from "../adapters/index.js";
import { getIssue, editIssue, listIssues, type Issue } from "../github/github.js";
import { byNumber, issueAgent, issueEffort, issueStatus, openDepsFromMap } from "../board/board.js";
import { STATUS, NEEDS_ATTENTION } from "../github/labels.js";
import { release as lockRelease } from "../git/lock.js";
import { removeWorktree } from "../git/worktree.js";
import { log } from "../util/log.js";
import { countCommitsAhead, resolveBaseBranch } from "../git/git.js";
import { appendRun, parseUsage, projectId, type RunPhase, type RunRecord } from "../board/telemetry.js";
import { appendEvent } from "./events.js";
import { logSize, readLogSince } from "../util/log-file.js";
import { estimateCost } from "../board/pricing.js";
import { noteUsageLimitFromLog, unavailableUntil } from "../board/availability.js";
import { writeSession } from "./sessions.js";

export interface RunSummary {
  issue: number;
  outcome: "submitted" | "needs-attention" | "failed" | "requeued";
  prUrl?: string;
  durationMs: number;
}

export function resolveTaskModel(
  agent: string,
  issue: Issue,
  cfg: OrchConfig,
): ModelSpec | undefined {
  const tier = issueEffort(issue) ?? cfg.defaultEffort ?? "hard";
  return cfg.adapters[agent]?.models?.[tier];
}

async function commitsAhead(worktree: string, cfg: OrchConfig, cwd: string): Promise<number> {
  const base = await resolveBaseBranch(cfg.baseBranch, cwd);
  return countCommitsAhead(base.ref, "HEAD", worktree);
}

/**
 * Put `agent` on cooldown when a failed run's log shows it ran out of usage. Only the text this
 * run appended counts (`since` is the log size before it started): the log is shared by every retry,
 * and an old attempt's usage-limit event must not pause the harness again for a different failure.
 */
function noteUsageLimit(agent: string, logFile: string, cwd: string, since: number): Date | null {
  try {
    const until = noteUsageLimitFromLog(agent, readLogSince(logFile, since), cwd);
    if (until) console.log(pc.yellow(`⏸ '${agent}' hit its usage limit — paused until ${until.toLocaleString()}`));
    return until;
  } catch {
    // An unreadable log just means no availability signal; the failure is handled as usual.
    return null;
  }
}

/** Validate that a specific open issue is a routed todo ready for dispatch. */
export function resolveDispatchAgent(
  issue: Issue,
  open: ReadonlyMap<number, Issue>,
  cfg: OrchConfig,
): string {
  if (issueStatus(issue) !== STATUS.todo) {
    throw new Error(`#${issue.number} is ${issueStatus(issue)}, not a todo.`);
  }
  const agent = issueAgent(issue);
  if (!agent) throw new Error(`#${issue.number} is not routed to an agent.`);
  if (!cfg.agents.includes(agent)) {
    throw new Error(`#${issue.number} is routed to unknown agent '${agent}'.`);
  }
  const blockers = openDepsFromMap(issue, new Map(open));
  if (blockers.length > 0) {
    throw new Error(`#${issue.number} is blocked by open issue(s): ${blockers.map((n) => `#${n}`).join(", ")}.`);
  }
  return agent;
}

/**
 * Append one best-effort telemetry record for a finished agent run. `meta.since` is the log size just
 * before the run: logs are append-only and shared by every retry of a round, so usage must be read from
 * that run's own range, or a later attempt that reported none would inherit (and re-record) an earlier
 * attempt's tokens and cost.
 */
export function recordRun(
  issue: number,
  agent: string,
  model: ModelSpec | undefined,
  outcome: string,
  durationMs: number,
  logFile: string,
  cwd: string,
  cfg: OrchConfig,
  meta: { phase?: RunPhase; round?: number; since?: number } = {},
): void {
  try {
    // A missing log reads as empty text: one record per completed run is preserved regardless.
    const usage = parseUsage(readLogSince(logFile, meta.since ?? 0), agent);
    // Prefer the harness-reported cost; fall back to a per-token estimate only
    // when pricing exists for this model (subscription agents have none → null).
    const costUsd = usage.costUsd ?? estimateCost(usage, model?.model ?? null, cfg.pricing);
    const rec: RunRecord = {
      ...(meta.phase ? { phase: meta.phase } : {}),
      ...(meta.round !== undefined ? { round: meta.round } : {}),
      ts: new Date().toISOString(),
      project: projectId(cwd),
      issue,
      agent,
      model: formatModelSpec(model) ?? null,
      outcome,
      durationMs,
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      tokensTotal: usage.tokensTotal,
      costUsd,
    };
    appendRun(rec, cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`could not record run telemetry: ${message}`);
  }
}

/**
 * Claim the next eligible task, drive the harness over it in its worktree, and
 * finalise: if the agent already submitted we leave it; if it produced commits
 * but didn't submit we auto-submit; otherwise we flag it for a human.
 * Returns null when there is nothing eligible to claim.
 */
export async function processNext(
  agent: string,
  cfg: OrchConfig,
  cwd: string,
  opts: {
    requireRouted?: boolean;
    /**
     * Called as soon as a task is claimed, before the harness starts. The agent may open its PR
     * (`orch submit`) while this call is still running, so a caller that also acts on open PRs needs
     * to know which issue is still being implemented in order to leave it alone until we return.
     */
    onClaimed?: (issue: number) => void;
  } = {},
): Promise<RunSummary | null> {
  const pausedUntil = unavailableUntil(agent, cwd);
  if (pausedUntil) {
    log.warn(`'${agent}' is paused until ${pausedUntil.toLocaleString()} (usage limit); not claiming work`);
    return null;
  }
  const task = await claimNext(agent, cfg, cwd, { requireRouted: opts.requireRouted });
  if (!task) return null;
  opts.onClaimed?.(task.issue.number);

  return processClaimed(task, agent, cfg, cwd);
}

/**
 * Claim and run one routed todo by issue number. Unlike `processNext`, selection
 * is explicit; execution and finalisation are shared through `processClaimed`.
 */
export async function dispatchSpecific(
  number: number,
  cfg: OrchConfig,
  cwd: string,
): Promise<RunSummary> {
  const issues = await listIssues({ cwd, state: "open" });
  const open = byNumber(issues);
  const issue = open.get(number);
  if (!issue) throw new Error(`#${number} is not an open issue.`);

  const agent = resolveDispatchAgent(issue, open, cfg);
  const pausedUntil = unavailableUntil(agent, cwd);
  if (pausedUntil) {
    throw new Error(`'${agent}' is paused until ${pausedUntil.toLocaleString()} (usage limit).`);
  }
  const task = await claimSpecific(number, agent, cfg, cwd);
  return processClaimed(task, agent, cfg, cwd);
}

/** Drive an already-claimed task through harness execution and finalisation. */
async function processClaimed(
  task: ClaimedTask,
  agent: string,
  cfg: OrchConfig,
  cwd: string,
): Promise<RunSummary> {
  const n = task.issue.number;
  const model = resolveTaskModel(agent, task.issue, cfg);
  const startedAt = Date.now();
  const logDir = resolve(cwd, "logs");
  const logFile = resolve(logDir, `issue-${n}.jsonl`);
  let summary: RunSummary;
  let telemetryOutcome: string;
  let harnessDurationMs: number | undefined;
  let preserveWorktree = false;
  let logMark = 0; // log size just before the harness ran (the log is shared by every retry)

  try {
    mkdirSync(logDir, { recursive: true });
    appendEvent({ type: "task.started", issue: n, agent }, cwd);
    await editIssue(n, { cwd, addLabels: [STATUS.inProgress], removeLabels: [STATUS.claimed] });
    console.log(pc.cyan(`▶ #${n} started by '${agent}' — ${task.worktree.path}`));

    const adapter = makeAdapter(agent, cfg);
    const prompt = buildBrief(task.issue, task.worktree, agent, cwd);
    logMark = logSize(logFile); // judge this run only by what it appends to the shared log
    const result = await adapter.runTask({
      issue: n,
      agent,
      worktree: task.worktree.path,
      prompt,
      model,
      logFile,
      timeoutMs: cfg.taskTimeoutMs,
    });
    harnessDurationMs = result.durationMs;
    if (result.sessionId) writeSession(n, { agent, sessionId: result.sessionId }, cwd);

    if (!result.ok) {
      const limitedUntil = noteUsageLimit(agent, logFile, cwd, logMark);
      // Running out of usage says nothing about the task: put it back in the queue for when the harness
      // returns, instead of parking it as needs-attention for a human. Only when nothing was left behind.
      if (limitedUntil && (await requeueClaim(n, task.worktree.path, cwd, { disposableIgnored: cfg.disposableIgnored }))) {
        console.log(pc.yellow(`↺ #${n} requeued — '${agent}' is out of usage until ${limitedUntil.toLocaleString()}`));
        summary = { issue: n, outcome: "requeued", durationMs: result.durationMs };
        telemetryOutcome = "usage-limited";
      } else {
        await recoverClaim(n, task.worktree.path, cwd, { disposableIgnored: cfg.disposableIgnored });
        console.log(pc.red(`✗ #${n} ${result.timedOut ? "timed out" : `exited ${result.code}`} — see ${logFile}`));
        summary = { issue: n, outcome: "failed", durationMs: result.durationMs };
        telemetryOutcome = "failed";
      }
    } else {
      // From this point a transient inspection/submit error may hide committed
      // work or an already-open PR, so unexpected recovery must retain ownership.
      preserveWorktree = true;
      // Did the agent submit itself (issue now in-review)?
      const cur = await getIssue(n, { cwd });
      if (issueStatus(cur) === STATUS.inReview) {
        console.log(pc.green(`✓ #${n} submitted by '${agent}'`));
        summary = { issue: n, outcome: "submitted", durationMs: result.durationMs };
        telemetryOutcome = "submitted";
      } else if ((await commitsAhead(task.worktree.path, cfg, cwd)) > 0) {
        // Agent finished but didn't submit — auto-submit if it produced work.
        const url = await submit(n, agent, cfg, cwd);
        console.log(pc.green(`✓ #${n} auto-submitted — ${url}`));
        summary = { issue: n, outcome: "submitted", prUrl: url, durationMs: result.durationMs };
        telemetryOutcome = "auto-submitted";
      } else {
        await recoverClaim(n, task.worktree.path, cwd, { disposableIgnored: cfg.disposableIgnored });
        console.log(pc.yellow(`⚠ #${n} produced no commits — flagged needs-attention`));
        summary = { issue: n, outcome: "needs-attention", durationMs: result.durationMs };
        telemetryOutcome = "needs-attention";
      }
    }
  } catch (error) {
    const durationMs = harnessDurationMs ?? Date.now() - startedAt;
    await recoverClaim(n, task.worktree.path, cwd, { preserveWorktree, disposableIgnored: cfg.disposableIgnored });
    log.error(`✗ #${n} runner failed: ${error instanceof Error ? error.message : String(error)}`);
    summary = { issue: n, outcome: "failed", durationMs };
    telemetryOutcome = "failed";
  }

  recordRun(n, agent, model, telemetryOutcome, summary.durationMs, logFile, cwd, cfg, { phase: "implement", since: logMark });
  return summary;
}

/**
 * Free a task's resources when a run does not produce a mergeable PR. Release
 * the claim lock only after safe cleanup proves there is no retained worktree;
 * otherwise the lock continues to protect recoverable work.
 */
async function recoverClaim(
  n: number,
  worktree: string,
  cwd: string,
  opts: { preserveWorktree?: boolean; disposableIgnored?: readonly string[] } = {},
): Promise<void> {
  try {
    await editIssue(n, {
      cwd,
      addLabels: [NEEDS_ATTENTION],
      removeLabels: [STATUS.claimed, STATUS.inProgress],
    });
  } catch (error) {
    warnRecovery(n, "could not mark needs-attention", error);
    return;
  }

  if (opts.preserveWorktree) return;

  let removed = false;
  try {
    removed = await removeWorktree(worktree, { cwd, disposableIgnored: opts.disposableIgnored });
  } catch (error) {
    warnRecovery(n, "safe worktree cleanup failed", error);
    return;
  }
  if (!removed) return;

  try {
    await lockRelease(n, { cwd });
  } catch (error) {
    warnRecovery(n, "claim lock release failed", error);
  }
}

/**
 * Return a task whose implement run died on a usage limit to `status:todo`. Safe cleanup runs first and
 * must prove nothing is left behind (a retained worktree means the agent produced work, which belongs to
 * a human or `orch repair`, not to a blind retry); the lock is released before the labels change so a
 * `todo` task never still looks claimed. Returns false, having changed no labels, when it cannot.
 */
async function requeueClaim(
  n: number,
  worktree: string,
  cwd: string,
  opts: { disposableIgnored?: readonly string[] } = {},
): Promise<boolean> {
  try {
    if (!(await removeWorktree(worktree, { cwd, disposableIgnored: opts.disposableIgnored }))) return false;
    await lockRelease(n, { cwd });
    await editIssue(n, { cwd, addLabels: [STATUS.todo], removeLabels: [STATUS.claimed, STATUS.inProgress] });
    return true;
  } catch (error) {
    warnRecovery(n, "requeue failed", error);
    return false;
  }
}

function warnRecovery(n: number, action: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  log.warn(`#${n} recovery ${action}: ${message}`);
}

/**
 * Dispatcher loop. Keeps up to `max` tasks in flight (each in its own worktree,
 * each claimed atomically) until no eligible issues remain.
 */
export async function runLoop(
  agent: string,
  cfg: OrchConfig,
  cwd: string,
  opts: { max?: number; once?: boolean } = {},
): Promise<RunSummary[]> {
  const summaries: RunSummary[] = [];

  if (opts.once) {
    const s = await processNext(agent, cfg, cwd);
    if (s) summaries.push(s);
    return summaries;
  }

  const max = Math.max(1, opts.max ?? cfg.maxConcurrent ?? 1);
  const active = new Set<Promise<void>>();
  const dispatcherFailures: unknown[] = [];
  let drained = false;

  const launch = (): void => {
    const p = processNext(agent, cfg, cwd)
      .then((s) => {
        if (s === null) drained = true;
        else summaries.push(s);
      })
      .catch((e: unknown) => {
        dispatcherFailures.push(e);
        drained = true;
      })
      .finally(() => active.delete(p));
    active.add(p);
  };

  while (!drained || active.size > 0) {
    while (!drained && active.size < max) launch();
    if (active.size > 0) await Promise.race(active);
    else break;
  }
  if (dispatcherFailures.length > 0) throw dispatcherFailures[0];
  return summaries;
}
