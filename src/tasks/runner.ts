import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import pc from "picocolors";
import { exec } from "../util/exec.js";
import type { OrchConfig } from "../config.js";
import { claimNext, submit } from "./service.js";
import { buildBrief } from "./brief.js";
import { makeAdapter } from "../adapters/index.js";
import { getIssue, editIssue, type Issue } from "../github/github.js";
import { issueEffort, issueStatus } from "../board/board.js";
import { STATUS, NEEDS_ATTENTION } from "../github/labels.js";
import { release as lockRelease } from "../git/lock.js";
import { removeWorktree, worktreePath } from "../git/worktree.js";
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

async function commitsAhead(worktree: string, base = "main"): Promise<number> {
  const r = await exec("git", ["rev-list", "--count", `${base}..HEAD`], { cwd: worktree });
  return r.code === 0 ? Number(r.stdout.trim()) || 0 : 0;
}

function recordRun(
  issue: number,
  agent: string,
  outcome: string,
  durationMs: number,
  logFile: string,
  cwd: string,
): void {
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

  const n = task.issue.number;
  const logDir = resolve(cwd, "logs");
  mkdirSync(logDir, { recursive: true });
  const logFile = resolve(logDir, `issue-${n}.jsonl`);

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

  if (!result.ok) {
    await editIssue(n, { cwd, addLabels: [NEEDS_ATTENTION] });
    await releaseClaim(n, cfg, cwd);
    console.log(pc.red(`✗ #${n} ${result.timedOut ? "timed out" : `exited ${result.code}`} — see ${logFile}`));
    recordRun(n, agent, "failed", result.durationMs, logFile, cwd);
    return { issue: n, outcome: "failed", durationMs: result.durationMs };
  }

  // Did the agent submit itself (issue now in-review)?
  const cur = await getIssue(n, { cwd });
  if (issueStatus(cur) === STATUS.inReview) {
    console.log(pc.green(`✓ #${n} submitted by '${agent}'`));
    recordRun(n, agent, "submitted", result.durationMs, logFile, cwd);
    return { issue: n, outcome: "submitted", durationMs: result.durationMs };
  }

  // Agent finished but didn't submit — auto-submit if it produced work.
  if ((await commitsAhead(task.worktree.path)) > 0) {
    const url = await submit(n, agent, cfg, cwd);
    console.log(pc.green(`✓ #${n} auto-submitted — ${url}`));
    recordRun(n, agent, "auto-submitted", result.durationMs, logFile, cwd);
    return { issue: n, outcome: "submitted", prUrl: url, durationMs: result.durationMs };
  }

  await editIssue(n, { cwd, addLabels: [NEEDS_ATTENTION], removeLabels: [STATUS.inProgress] });
  await releaseClaim(n, cfg, cwd);
  console.log(pc.yellow(`⚠ #${n} produced no commits — flagged needs-attention`));
  recordRun(n, agent, "needs-attention", result.durationMs, logFile, cwd);
  return { issue: n, outcome: "needs-attention", durationMs: result.durationMs };
}

/**
 * Free a task's resources when a run does not produce a mergeable PR: drop the
 * claim lock and prune the worktree so the issue can be re-claimed later. The
 * `needs-attention` label stays on the issue as the human signal.
 */
async function releaseClaim(n: number, cfg: OrchConfig, cwd: string): Promise<void> {
  await lockRelease(n, { cwd });
  await removeWorktree(worktreePath(cfg.worktreeRoot, n, cwd), { cwd });
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
  let drained = false;

  const launch = (): void => {
    const p = processNext(agent, cfg, cwd)
      .then((s) => {
        if (s === null) drained = true;
        else summaries.push(s);
      })
      .catch((e: unknown) => {
        console.error(pc.red("runner error: ") + (e instanceof Error ? e.message : String(e)));
      })
      .finally(() => active.delete(p));
    active.add(p);
  };

  while (!drained || active.size > 0) {
    while (!drained && active.size < max) launch();
    if (active.size > 0) await Promise.race(active);
    else break;
  }
  return summaries;
}
