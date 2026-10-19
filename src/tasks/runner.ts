import { renderPackBrief, storeBrief } from "./brief-render.js";
import { BudgetSpentError, runBudget } from "./budget-runtime.js";
import { cascadeLabels, cascadeRequeue } from "./cascade-requeue.js";
import { issueRole, validateRoute } from "../routing/route-policy.js";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import pc from "picocolors";
import { formatModelSpec, resolvePricingMode, resolveTierModel, type CascadeRoute, type ModelSpec, type OrchConfig } from "../config.js";
import { nextHop } from "./cascade.js";
import { claimNext, claimSpecific, submit, type ClaimedTask } from "./service.js";
import { buildBrief } from "./brief.js";
import { makeAdapter } from "../adapters/index.js";
import { getIssue, editIssue, ensureLabels, listIssues, listOpenPrs, type Issue } from "../github/github.js";
import { prIssueNumber } from "../board/review.js";
import { byNumber, issueAgent, issueEffort, issueStatus, openDepsFromMap, type ClaimFilter } from "../board/board.js";
import { STATUS, NEEDS_ATTENTION, labelDefs } from "../github/labels.js";
import { release as lockRelease } from "../git/lock.js";
import { removeWorktree } from "../git/worktree.js";
import { log } from "../util/log.js";
import { countCommitsAhead, resolveBaseBranch } from "../git/git.js";
import { appendRun, parseUsage, projectId, type RunPhase, type RunRecord } from "../board/telemetry.js";
import { appendEvent } from "./events.js";
import { logSize, readLogSince } from "../util/log-file.js";
import { estimateCost } from "../board/pricing.js";
import { availabilityKey, markUnavailable, noteUsageLimitFromLog, unavailableUntil } from "../board/availability.js";
import { incrementQuota } from "../board/quota.js";
import { writeSession } from "./sessions.js";
import { endpointHealthy } from "../board/health.js";
import { ENDPOINT_COOLDOWN_MS } from "../adapters/usage-limit.js";
import { exec } from "../util/exec.js";
import { parseTicketV2 } from "./plan.js";
import { verifyEnvironment, verifyTrustErrors } from "./verify.js";

class VerificationFailed extends Error {}
class RouteRefusal extends Error {}

/** Finish a worker's uncommitted output using only coordinator-loaded configuration. */
async function commitWorkerOutput(task: ClaimedTask, agent: string, model: ModelSpec | undefined, cfg: OrchConfig): Promise<boolean> {
  const cwd = task.worktree.path;
  const git = async (args: string[]) => {
    const result = await exec("git", args, { cwd });
    if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
    return result.stdout;
  };
  const assertBranch = async () => {
    if ((await git(["symbolic-ref", "--short", "HEAD"])).trim() !== task.worktree.branch) {
      throw new Error("Worker worktree is no longer on the claimed task branch");
    }
  };
  await assertBranch();
  if (!(await git(["status", "--porcelain", "--untracked-files=all"])).trim()) return false;
  const ticketVerify = parseTicketV2(task.issue.body).verify ?? [];
  const trustErrors = verifyTrustErrors(ticketVerify, cfg.verify ?? []);
  if (trustErrors.length) throw new VerificationFailed(`Ticket #${task.issue.number}: ${trustErrors.join("; ")}`);
  for (const argv of [...cfg.verify ?? [], ...ticketVerify]) {
    const result = await exec(argv[0], argv.slice(1), { cwd, timeoutMs: 300_000, env: verifyEnvironment() });
    if (result.code !== 0) {
      const tail = `${result.stdout}\n${result.stderr}`.slice(-6000);
      throw new VerificationFailed(`Coordinator verification failed (exit ${result.code}). Worktree and claim retained; no commit or submission.\n\nCommand (argv): ${JSON.stringify(argv)}\n\nOutput tail:\n${tail.split(/\r?\n/).map(line => `    ${line}`).join("\n")}`);
    }
  }
  await assertBranch();
  await git(["add", "--all"]);
  await git(["commit", "-m", `${task.issue.title} (#${task.issue.number})`, "-m",
    `Worker: ${agent}; model: ${formatModelSpec(model) ?? "default"}`]);
  return true;
}

export interface RunSummary {
  issue: number;
  outcome: "submitted" | "needs-attention" | "failed" | "requeued";
  prUrl?: string;
  reason?: string;
  durationMs: number;
}

export function resolveTaskModel(
  agent: string,
  issue: Issue,
  cfg: OrchConfig,
  opts: { purpose?: "implementation" | "review" } = {},
): ModelSpec | undefined {
  const tier = issueEffort(issue, cfg.tierAliases) ?? cfg.defaultEffort ?? "lead";
  const model = opts.purpose === "review" ? cfg.adapters[agent]?.models?.[tier] :
    resolveTierModel(agent, tier, cfg, issueAgent(issue) === agent ? issue.labels : []);
  // Role allowances constrain writable implementation, not independent review.
  if (opts.purpose !== "review") {
    try {
      const route = validateRoute({ ...parseTicketV2(issue.body), role: issueRole(issue), agent, tier, model }, cfg);
      if (!route.ok) throw new Error(route.reason);
    } catch (error) { throw new RouteRefusal(`#${issue.number}: disallowed route: ${(error as Error).message}`); }
  }
  return model;
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
  if (issue.labels.includes(NEEDS_ATTENTION)) {
    throw new Error(`#${issue.number} needs-attention; human recovery is required before dispatch.`);
  }
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
  resolveTaskModel(agent, issue, cfg); // refuse before claiming resources
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
  meta: { phase?: RunPhase; round?: number; since?: number; cascadeFrom?: CascadeRoute; cascadeTo?: CascadeRoute } = {},
): void {
  try {
    // A missing log reads as empty text: one record per completed run is preserved regardless.
    const usage = parseUsage(readLogSince(logFile, meta.since ?? 0), agent);
    // Quota billing tracks requests instead of dollars, even if the provider emits a cost.
    // Other modes preserve reported cost, with API token pricing as a fallback.
    const mode = resolvePricingMode(agent, cfg);
    const costUsd = mode === "quota" ? 0 : usage.costUsd ?? estimateCost(usage, model?.model ?? null, cfg.pricing, mode);
    const rec: RunRecord = {
      ...(meta.cascadeFrom ? { cascadeFrom: meta.cascadeFrom, cascadeTo: meta.cascadeTo } : {}),
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
      requests: Math.max(1, usage.requests ?? 1),
    };
    appendRun(rec, cwd);
    if (mode === "quota" && model?.model && usage.requests !== undefined) {
      incrementQuota(availabilityKey(agent, model.model), usage.requests, cwd, new Date(rec.ts));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`could not record run telemetry: ${message}`);
  }
}

/**
 * Claim the next eligible task, drive the harness over it in its worktree, and
 * finalise: if the agent already submitted we leave it; if it produced commits
 * but didn't submit we auto-submit; uncommitted output is verified and committed
 * by the coordinator first. Empty output is flagged for a human.
 * Returns null when there is nothing eligible to claim.
 */
export async function processNext(
  agent: string,
  cfg: OrchConfig,
  cwd: string,
  opts: ClaimFilter & {
    /**
     * Called as soon as a task is claimed, before the harness starts. The agent may open its PR
     * (`orch submit`) while this call is still running, so a caller that also acts on open PRs needs
     * to know which issue is still being implemented in order to leave it alone until we return.
     */
    onClaimed?: (issue: number) => void;
    /** A successful cascade changed routing; wake the destination harness even if no task was claimed. */
    onCascade?: (agent: string) => void;
  } = {},
): Promise<RunSummary | null> {
  const pausedUntil = unavailableUntil(agent, cwd);
  if (pausedUntil) {
    log.warn(`'${agent}' is paused until ${pausedUntil.toLocaleString()} (usage limit); not claiming work`);
    return null;
  }
  const task = await claimNext(agent, cfg, cwd, {
    requireRouted: opts.requireRouted, only: opts.only,
    canClaim: async (issue: Issue) => {
      if (await refuseRoute(issue, agent, cfg, cwd)) return false;
      return agent !== "opencode" || preClaimHealthy(issue, agent, cfg, cwd, opts.onCascade);
    },
  });
  if (!task) return null;
  opts.onClaimed?.(task.issue.number);

  return processClaimed(task, agent, cfg, cwd, opts.onCascade);
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

  let agent: string;
  try { agent = resolveDispatchAgent(issue, open, cfg); }
  catch (error) {
    if (!(error instanceof RouteRefusal)) throw error;
    await refuseRoute(issue, issueAgent(issue)!, cfg, cwd);
    return { issue: number, outcome: "needs-attention", reason: "disallowed route", durationMs: 0 };
  }
  const key = availabilityKey(agent, resolveTaskModel(agent, issue, cfg)?.model);
  const pausedUntil = unavailableUntil(key, cwd);
  if (pausedUntil) {
    throw new Error(`'${key}' is paused until ${pausedUntil.toLocaleString()} (usage limit).`);
  }
  if (!(await preClaimHealthy(issue, agent, cfg, cwd))) {
    return { issue: number, outcome: "requeued", durationMs: 0 };
  }
  const task = await claimSpecific(number, agent, cfg, cwd);
  if (!task) return { issue: number, outcome: "requeued", durationMs: 0 };
  return processClaimed(task, agent, cfg, cwd);
}

/** A refusal spends no request budget and never constructs an adapter. */
async function refuseRoute(issue: Issue, agent: string, cfg: OrchConfig, cwd: string): Promise<boolean> {
  try { resolveTaskModel(agent, issue, cfg); return false; }
  catch (error) {
    if (!(error instanceof RouteRefusal)) throw error;
    await editIssue(issue.number, { cwd, addLabels: [NEEDS_ATTENTION], removeLabels: [STATUS.todo] });
    appendEvent({ type: "task.escalated", issue: issue.number, agent, detail: error.message }, cwd);
    log.warn(error.message);
    return true;
  }
}

/** No harness or claim resources have been created: only advance the todo's route. */
async function preClaimHealthy(issue: Issue, agent: string, cfg: OrchConfig, cwd: string, onCascade?: (agent: string) => void): Promise<boolean> {
  const model = resolveTaskModel(agent, issue, cfg);
  if (await endpointHealthy(agent, model?.model, cwd, cfg.adapters[agent])) return true;
  const current: CascadeRoute = { agent, ...model, tier: issueEffort(issue, cfg.tierAliases) ?? cfg.defaultEffort ?? "lead" };
  const hop = nextHop(current, [], issueRole(issue), cfg,
    member => !unavailableUntil(availabilityKey(member.agent, member.model), cwd), parseTicketV2(issue.body));
  if (hop) {
    // Failed relabels must not report a hop. Keep this path free of run telemetry:
    // no implementation harness ran and no ticket request budget was consumed.
    await cascadeRequeue(issue, hop, cwd);
    appendEvent({ type: "cascade.hop", issue: issue.number, agent, cascadeFrom: current, cascadeTo: hop }, cwd);
    onCascade?.(hop.agent);
  }
  return false;
}

/** Drive an already-claimed task through harness execution and finalisation. */
async function processClaimed(
  task: ClaimedTask,
  agent: string,
  cfg: OrchConfig,
  cwd: string,
  onCascade?: (agent: string) => void,
): Promise<RunSummary> {
  const n = task.issue.number;
  let limits: ReturnType<typeof runBudget>;
  try { limits = runBudget(task.issue, cfg, cwd); }
  catch (error) {
    if (!(error instanceof BudgetSpentError)) throw error;
    await editIssue(n, { cwd, addLabels: [NEEDS_ATTENTION] });
    log.warn("#" + n + ": budget spent; handing task to a human");
    return { issue: n, outcome: "needs-attention", reason: "budget spent", durationMs: 0 };
  }
  let prompt: string | undefined;
  if (cfg.pack !== undefined) {
    try {
      prompt = renderPackBrief(task.issue, cfg, cwd);
      storeBrief(n, prompt, cwd);
    } catch (error) {
      const reason = `Incomplete brief: ${error instanceof Error ? error.message : String(error)}`;
      await recoverClaim(n, task.worktree.path, cwd, { disposableIgnored: cfg.disposableIgnored });
      appendEvent({ type: "task.escalated", issue: n, agent, detail: reason }, cwd);
      log.warn(`#${n}: ${reason}`);
      return { issue: n, outcome: "needs-attention", reason, durationMs: 0 };
    }
  }
  if (await refuseRoute(task.issue, agent, cfg, cwd)) {
    await recoverClaim(n, task.worktree.path, cwd, { disposableIgnored: cfg.disposableIgnored });
    return { issue: n, outcome: "needs-attention", reason: "disallowed route", durationMs: 0 };
  }
  const model = resolveTaskModel(agent, task.issue, cfg);
  const startedAt = Date.now();
  const logDir = resolve(cwd, "logs");
  const logFile = resolve(logDir, `issue-${n}.jsonl`);
  let summary: RunSummary;
  let telemetryOutcome: string;
  let harnessDurationMs: number | undefined;
  let preserveWorktree = false;
  let logMark = 0; // log size just before the harness ran (the log is shared by every retry)
  let cascadeFrom: CascadeRoute | undefined;
  let cascadeTo: CascadeRoute | undefined;

  try {
    mkdirSync(logDir, { recursive: true });
    appendEvent({ type: "task.started", issue: n, agent }, cwd);
    await editIssue(n, { cwd, addLabels: [STATUS.inProgress], removeLabels: [STATUS.claimed] });
    console.log(pc.cyan(`▶ #${n} started by '${agent}' — ${task.worktree.path}`));

    const adapter = makeAdapter(agent, cfg);
    logMark = logSize(logFile); // judge this run only by what it appends to the shared log
    const result = await adapter.runTask({
      issue: n,
      agent,
      worktree: task.worktree.path,
      prompt: prompt ?? buildBrief(task.issue, task.worktree, agent, cwd),
      model,
      logFile,
      ...limits,
    });
    harnessDurationMs = result.durationMs;
    if (result.sessionId) writeSession(n, { agent, sessionId: result.sessionId }, cwd);

    // A ticket time cap shortens the ordinary harness timeout. Preserve that cause
    // before generic failure/usage-limit handling loses it.
    if (result.timedOut && limits.timeoutMs < cfg.taskTimeoutMs) {
      await recoverClaim(n, task.worktree.path, cwd, { disposableIgnored: cfg.disposableIgnored });
      console.log(pc.yellow(`⚠ #${n} time budget spent (${limits.timeoutMs / 60_000}m remaining at start) — see ${logFile}`));
      summary = { issue: n, outcome: "needs-attention", reason: "budget spent", durationMs: result.durationMs };
      telemetryOutcome = "budget-spent";
    } else if (!result.ok) {
      const key = availabilityKey(agent, model?.model);
      const limitedUntil = noteUsageLimit(key, logFile, cwd, logMark) ??
        (result.outcome === "quota" || result.outcome === "endpoint-unavailable"
          ? markUnavailable(key, {
            resetAt: result.outcome === "endpoint-unavailable" ? new Date(Date.now() + ENDPOINT_COOLDOWN_MS).toISOString() : null,
            reason: result.outcome,
          }, cwd) : null);
      const current: CascadeRoute = { agent, ...model, tier: issueEffort(task.issue, cfg.tierAliases) ?? cfg.defaultEffort ?? "lead" };
      const hop = limitedUntil ? nextHop(current, [], issueRole(task.issue), cfg,
        member => !unavailableUntil(availabilityKey(member.agent, member.model), cwd), parseTicketV2(task.issue.body)) : null;
      // Running out of usage says nothing about the task: put it back in the queue for when the harness
      // returns, instead of parking it as needs-attention for a human. Only when nothing was left behind.
      if (limitedUntil && (await requeueClaim(n, task.worktree.path, cfg, cwd, hop ? { issue: task.issue, route: hop } : undefined))) {
        if (hop) {
          cascadeFrom = current;
          cascadeTo = hop;
          appendEvent({ type: "cascade.hop", issue: n, agent, cascadeFrom, cascadeTo }, cwd);
          console.log(pc.yellow(`↪ #${n} cascaded to '${hop.agent}' (${hop.tier}, ${hop.model ?? "default"})`));
        }
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
      } else if ((await commitsAhead(task.worktree.path, cfg, cwd)) > 0 ||
          await commitWorkerOutput(task, agent, model, cfg)) {
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
    if (error instanceof VerificationFailed) {
      const comment = await exec("gh", ["issue", "comment", String(n), "--body-file", "-"], { cwd, input: error.message });
      if (comment.code !== 0) log.warn(`#${n}: could not comment verification failure: ${comment.stderr}`);
    }
    log.error(`✗ #${n} runner failed: ${error instanceof Error ? error.message : String(error)}`);
    summary = { issue: n, outcome: error instanceof VerificationFailed ? "needs-attention" : "failed", durationMs };
    telemetryOutcome = summary.outcome;
  }

  recordRun(n, agent, model, telemetryOutcome, summary.durationMs, logFile, cwd, cfg, { phase: "implement", since: logMark, cascadeFrom, cascadeTo });
  if (cascadeTo) onCascade?.(cascadeTo.agent);
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
 * Return a task whose implement run died on a usage limit to `status:todo`, but only when the run
 * demonstrably left nothing behind. A removable worktree is not that proof: safe cleanup also allows a
 * clean worktree whose commits are preserved elsewhere (a pushed branch, an open PR), and requeueing that
 * would run the task again over its own work. So, before touching anything, require no commits ahead of
 * the base and no open PR for the issue, failing closed when either cannot be observed. Then cleanup must
 * actually remove the worktree (retained work belongs to a human or `orch repair`), and the lock is
 * released before the labels change so a `todo` task never still looks claimed. Returns false, having
 * changed no labels, when any of that does not hold.
 */
async function requeueClaim(n: number, worktree: string, cfg: OrchConfig, cwd: string, cascade?: { issue: Issue; route: CascadeRoute }): Promise<boolean> {
  try {
    if ((await commitsAhead(worktree, cfg, cwd)) > 0) return false;
    if ((await listOpenPrs({ cwd })).some((pr) => prIssueNumber(pr) === n)) return false;
    const addLabels = [STATUS.todo as string];
    const removeLabels = [STATUS.claimed as string, STATUS.inProgress as string];
    if (cascade) {
      const labels = cascadeLabels(cascade.issue, cascade.route);
      addLabels.push(...labels.addLabels);
      removeLabels.push(...labels.removeLabels, NEEDS_ATTENTION);
      await ensureLabels(labelDefs(addLabels), cwd);
    }
    if (!(await removeWorktree(worktree, { cwd, disposableIgnored: cfg.disposableIgnored }))) return false;
    // release() reports failure by returning false, not by throwing: a lock that is still held must never
    // be relabelled todo (it would read as claimed and the task could not run after the cooldown).
    if (!(await lockRelease(n, { cwd }))) return false;
    await editIssue(n, { cwd, addLabels, removeLabels: removeLabels.filter((label) => !addLabels.includes(label)) });
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
