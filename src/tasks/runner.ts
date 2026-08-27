import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import pc from "picocolors";
import type { OrchConfig } from "../config.js";
import { claimNext, claimSpecific, submit, type ClaimedTask } from "./service.js";
import { buildBrief } from "./brief.js";
import { makeAdapter } from "../adapters/index.js";
import { getIssue, editIssue, listIssues, type Issue } from "../github/github.js";
import { byNumber, issueAgent, issueEffort, issueStatus, openDepsFromMap } from "../board/board.js";
import { STATUS, NEEDS_ATTENTION } from "../github/labels.js";
import { release as lockRelease } from "../git/lock.js";
import { removeWorktree } from "../git/worktree.js";
import { countCommitsAhead, resolveBaseBranch } from "../git/git.js";
import { appendRun, parseUsage, projectId, type RunRecord } from "../board/telemetry.js";

export interface RunSummary {
  issue: number;
  outcome: "submitted" | "needs-attention" | "failed";
  prUrl?: string;
  durationMs: number;
}

export function resolveTaskModel(
  agent: string,
  issue: Issue,
  cfg: OrchConfig,
): string | undefined {
  const tier = issueEffort(issue) ?? cfg.defaultEffort ?? "hard";
  return cfg.adapters[agent]?.models?.[tier];
}

async function commitsAhead(worktree: string, cfg: OrchConfig, cwd: string): Promise<number> {
  const base = await resolveBaseBranch(cfg.baseBranch, cwd);
  return countCommitsAhead(base.ref, "HEAD", worktree);
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

function recordRun(
  issue: number,
  agent: string,
  outcome: string,
  durationMs: number,
  logFile: string,
  cwd: string,
): void {
  try {
    let logText = "";
    try {
      logText = readFileSync(logFile, "utf8");
    } catch {
      // Preserve one record per completed run even when its log is unavailable.
    }

    const usage = parseUsage(logText, agent);
    const rec: RunRecord = {
      ts: new Date().toISOString(),
      project: projectId(cwd),
      issue,
      agent,
      outcome,
      durationMs,
      ...usage,
    };
    appendRun(rec, cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`warning: could not record run telemetry: ${message}`);
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
): Promise<RunSummary | null> {
  const task = await claimNext(agent, cfg, cwd);
  if (!task) return null;

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
  const startedAt = Date.now();
  const logDir = resolve(cwd, "logs");
  const logFile = resolve(logDir, `issue-${n}.jsonl`);
  let summary: RunSummary;
  let telemetryOutcome: string;
  let harnessDurationMs: number | undefined;
  let preserveWorktree = false;

  try {
    mkdirSync(logDir, { recursive: true });
    await editIssue(n, { cwd, addLabels: [STATUS.inProgress], removeLabels: [STATUS.claimed] });
    console.log(pc.cyan(`▶ #${n} started by '${agent}' — ${task.worktree.path}`));

    const adapter = makeAdapter(agent, cfg);
    const prompt = buildBrief(task.issue, task.worktree, agent, cwd);
    const model = resolveTaskModel(agent, task.issue, cfg);
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

    if (!result.ok) {
      await recoverClaim(n, task.worktree.path, cwd);
      console.log(pc.red(`✗ #${n} ${result.timedOut ? "timed out" : `exited ${result.code}`} — see ${logFile}`));
      summary = { issue: n, outcome: "failed", durationMs: result.durationMs };
      telemetryOutcome = "failed";
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
        await recoverClaim(n, task.worktree.path, cwd);
        console.log(pc.yellow(`⚠ #${n} produced no commits — flagged needs-attention`));
        summary = { issue: n, outcome: "needs-attention", durationMs: result.durationMs };
        telemetryOutcome = "needs-attention";
      }
    }
  } catch (error) {
    const durationMs = harnessDurationMs ?? Date.now() - startedAt;
    await recoverClaim(n, task.worktree.path, cwd, { preserveWorktree });
    console.error(pc.red(`✗ #${n} runner failed: ${error instanceof Error ? error.message : String(error)}`));
    summary = { issue: n, outcome: "failed", durationMs };
    telemetryOutcome = "failed";
  }

  recordRun(n, agent, telemetryOutcome, summary.durationMs, logFile, cwd);
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
  opts: { preserveWorktree?: boolean } = {},
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
    removed = await removeWorktree(worktree, { cwd });
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

function warnRecovery(n: number, action: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`warning: #${n} recovery ${action}: ${message}`);
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
