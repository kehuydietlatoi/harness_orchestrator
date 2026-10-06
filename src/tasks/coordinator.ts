import { eligibleIssues, issueAgent } from "../board/board.js";
import type { OrchConfig } from "../config.js";
import { unavailableUntil } from "../board/availability.js";
import { appendEvent, type OrchEvent } from "./events.js";
import { observeTasks, type Observation, type TaskObservation } from "./observe.js";
import { processNext, type RunSummary } from "./runner.js";
import {
  executeEscalate, executeFix, executeMerge, executeResolveConflict, executeReview, type StepResult,
} from "./step-exec.js";
import type { Step } from "./steps.js";

/** Steps the coordinator performs (the rest of `Step` is "do nothing, just report"). */
export type ActionableStep = Extract<Step, { kind: "review" | "fix" | "resolve-conflict" | "merge" | "escalate" }>;

export interface AutopilotOptions {
  /** Agent runs in flight at once. */
  max: number;
  /** How often to re-observe when nothing finishes (CI and humans change state without signalling us). */
  pollMs: number;
  /** Give up waiting on external events (CI, a cooled-down harness) after this long with nothing running. */
  maxIdleMs: number;
  /** Stop launching new work (in-flight steps still finish). */
  signal?: AbortSignal;
  /**
   * Which new tasks the loop may start: `routed` (default) only issues someone labelled with an
   * `agent:`, `none` only drives pull requests that already exist.
   */
  claim?: "routed" | "none";
}

export interface AutopilotSummary {
  merged: number[];
  escalated: number[];
  /** Tasks the loop implemented and submitted for review. */
  submitted: number[];
  /** Approved and green but waiting for a human because `requireHumanMerge` is on. */
  awaitingHuman: number[];
  /** Issues with more than one open PR: which one is "the" task PR is a human decision, so none is driven. */
  ambiguous: number[];
  /** Issues that needed a human but could not be escalated (its label/comment writes kept failing). Look at these first. */
  escalationFailed: number[];
  failures: number;
  stopped: "drained" | "idle-timeout" | "aborted";
}

/** All I/O the loop performs, injected so whole task lifecycles can be simulated in tests. */
export interface CoordinatorDeps {
  observe(): Promise<Observation>;
  execute(obs: TaskObservation, step: ActionableStep): Promise<StepResult>;
  /**
   * Claim and implement the next task routed to `agent`; null when there is nothing for it.
   * `onClaimed` fires as soon as the issue is claimed, before the harness runs: the agent can open its
   * own PR (`orch submit`) while this call is still in progress, and the loop must not act on that PR
   * (review, fix, merge) until the implementation has finished and finalised.
   */
  implement(agent: string, onClaimed: (issue: number) => void): Promise<RunSummary | null>;
  availableAgents(): string[];
  /** Issues that are routed and ready but belong to a harness that is currently paused. */
  blockedBacklog(): Promise<number[]>;
  now(): number;
  /** `unref` timers do not keep the process alive; the loop uses them only while a child process does. */
  sleep(ms: number, opts?: { unref?: boolean }): Promise<void>;
  record(event: Omit<OrchEvent, "ts">): void;
  say(line: string): void;
}

/** Finish work before starting new work, and cheap decisive steps before slow agent runs. */
const PRIORITY: Record<ActionableStep["kind"], number> = {
  merge: 0, escalate: 1, fix: 2, "resolve-conflict": 3, review: 4,
};

/** Consecutive failed attempts at a task's step before a human is called in. */
export const MAX_STEP_FAILURES = 2;
/**
 * Failed attempts at escalating one task (the label or comment write itself failing) before the loop stops
 * trying and just reports it. Escalation is the safety valve, so it is retried, but never without bound.
 */
export const MAX_ESCALATION_FAILURES = 3;
const FAILURE_BACKOFF_MS = 30_000;
const UNAVAILABLE_BACKOFF_MS = 60_000;

export function defaultDeps(cfg: OrchConfig, cwd: string): CoordinatorDeps {
  return {
    observe: () => observeTasks(cfg, cwd),
    execute: (obs, step) => {
      switch (step.kind) {
        case "review": return executeReview(obs, cfg, cwd);
        case "fix": return executeFix(obs, step.reason, cfg, cwd);
        case "resolve-conflict": return executeResolveConflict(obs, cfg, cwd);
        case "merge": return executeMerge(obs, cfg, cwd);
        case "escalate": return executeEscalate(obs, step.reason, cwd);
      }
    },
    // Unrouted backlog is never started by a loop that merges on its own.
    implement: (agent, onClaimed) => processNext(agent, cfg, cwd, { requireRouted: true, onClaimed }),
    availableAgents: () => cfg.agents.filter((a) => unavailableUntil(a, cwd) === null),
    blockedBacklog: async () => {
      const paused = new Set(cfg.agents.filter((a) => unavailableUntil(a, cwd) !== null));
      if (paused.size === 0) return [];
      const eligible = await eligibleIssues(cwd);
      return eligible.filter((i) => paused.has(issueAgent(i) ?? "")).map((i) => i.number);
    },
    now: () => Date.now(),
    sleep: (ms, opts) =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        if (opts?.unref) timer.unref();
      }),
    record: (event) => appendEvent(event, cwd),
    say: (line) => console.log(line),
  };
}

function isActionable(step: Step): step is ActionableStep {
  return step.kind === "review" || step.kind === "fix" || step.kind === "resolve-conflict" ||
    step.kind === "merge" || step.kind === "escalate";
}

function describe(step: ActionableStep): string {
  return step.kind === "fix" ? `fix (${step.reason})` : step.kind;
}

/**
 * Drive tasks from claim to merge. Each pass observes the board, picks the next step for every
 * task from facts alone (`decideStep`), and fills the free slots - finish-before-start. When a
 * step ends, its result wakes the loop at once (the signal); polling exists only for events that
 * never signal us (CI finishing, a human acting, a harness's usage limit resetting).
 *
 * A signal is never trusted as state: it is logged and the next pass re-derives everything from
 * GitHub/Git, so a crash, a lost signal, or an external edit cannot strand a task. Failures back
 * off, and a task that fails twice in a row or exhausts its round budget is escalated to a human.
 */
export async function runAutopilot(opts: AutopilotOptions, deps: CoordinatorDeps): Promise<AutopilotSummary> {
  const max = Math.max(1, opts.max);
  const summary: AutopilotSummary = { merged: [], escalated: [], submitted: [], awaitingHuman: [], ambiguous: [], escalationFailed: [], failures: 0, stopped: "drained" };
  const inflight = new Map<string, Promise<void>>();
  /** Consecutive failures of ONE step on an issue. A different step starts a fresh count: a failed review followed
   * by an external approval and one failed merge is a first failure of the merge, not a second failure. */
  const failing = new Map<number, { count: number; detail: string; step: string }>();
  /** The step that last ended in `agent.unavailable` per issue: relaunching that same step is a retry after a
   * pause, not new work. A different step on the same issue is real work. */
  const lastUnavailable = new Map<number, string>();
  /** When a refused or failed step may be tried again. Tied to that step: backing off a review says nothing
   * about a merge that became ready meanwhile (e.g. after a manual approval), which needs no agent at all. */
  const retryAt = new Map<number, { at: number; step: string }>();
  /** Failed escalation attempts per issue, and when the next may start. Kept apart from ordinary step failures. */
  const escalationFailures = new Map<number, number>();
  const escalateRetryAt = new Map<number, number>();
  const drained = new Set<string>();
  /** Issues an implementation has claimed and not yet finalised: their PR may already exist, but is not ours to touch. */
  const implementing = new Set<number>();
  /**
   * Issues whose step (or implementation) finished while the board was being read. `deps.observe()` makes several
   * GitHub calls and a running step can finish in the middle of them, so what it returns may describe the world
   * *before* that step: old head, old review feedback, old round count. Acting on it would, for example, launch a
   * second fix for feedback the first fix already addressed. Such tasks are dropped for this pass and re-observed.
   */
  const settledDuringObserve = new Set<number>();
  /** When a step last finished or a task was last implemented. Idle time is measured from here,
   * not from "nothing in flight", because probing a harness for new work is not progress. */
  let lastProgress = deps.now();

  const settle = (issue: number, step: string, result: StepResult, startedAt: number, identity: string = step): void => {
    settledDuringObserve.add(issue);
    if (result.signal === "agent.unavailable") lastUnavailable.set(issue, identity);
    else lastUnavailable.delete(issue);
    // Neither a refusal because a harness is paused nor a failed escalation is progress: counting them would
    // let a cooldown, or a label write that keeps failing, reset the timer forever so --max-idle never fires.
    const failedEscalation = step === "escalate" && result.signal === "step.failed";
    if (result.signal !== "agent.unavailable" && !failedEscalation) lastProgress = deps.now();
    deps.record({ type: "step.finished", issue, step, signal: result.signal, detail: result.detail, durationMs: deps.now() - startedAt });
    deps.say(`  #${issue} ${step} -> ${result.signal}${result.detail ? ` (${result.detail})` : ""}`);
    switch (result.signal) {
      case "step.failed": {
        if (failedEscalation) {
          // Escalating itself failed: back off and retry a bounded number of times, then stop and report.
          const attempts = (escalationFailures.get(issue) ?? 0) + 1;
          escalationFailures.set(issue, attempts);
          escalateRetryAt.set(issue, deps.now() + FAILURE_BACKOFF_MS * attempts);
          summary.failures += 1;
          if (attempts >= MAX_ESCALATION_FAILURES && !summary.escalationFailed.includes(issue)) {
            summary.escalationFailed.push(issue);
            deps.say(`  #${issue} could not be escalated after ${attempts} attempts; it needs a human and is not being retried`);
          }
          break;
        }
        const previous = failing.get(issue);
        const count = (previous && previous.step === identity ? previous.count : 0) + 1;
        failing.set(issue, { count, detail: result.detail ?? "unknown error", step: identity });
        retryAt.set(issue, { at: deps.now() + FAILURE_BACKOFF_MS * count, step: identity });
        summary.failures += 1;
        break;
      }
      case "agent.unavailable":
        retryAt.set(issue, { at: deps.now() + Math.max(opts.pollMs, UNAVAILABLE_BACKOFF_MS), step: identity });
        break;
      case "task.merged":
        summary.merged.push(issue);
        failing.delete(issue);
        drained.clear(); // a merge can unblock dependents
        break;
      case "task.escalated":
        summary.escalated.push(issue);
        escalationFailures.delete(issue);
        escalateRetryAt.delete(issue);
        // The task is now a human's. The comment promises that removing `needs-attention` hands it back to the
        // loop, so whatever made us escalate must not linger: with the old failure count still on record, a
        // handback while we are running would re-escalate at once instead of trying the step again.
        failing.delete(issue);
        retryAt.delete(issue);
        lastUnavailable.delete(issue);
        break;
      default:
        failing.delete(issue);
        retryAt.delete(issue);
    }
  };

  const launchStep = (obs: TaskObservation, step: ActionableStep): void => {
    const n = obs.issue.number;
    const key = `issue:${n}`;
    if (inflight.has(key)) return; // never overwrite a running step's entry: its completion would clear ours
    const startedAt = deps.now();
    deps.record({ type: "step.started", issue: n, step: step.kind, pr: obs.pr.number, agent: obs.author });
    deps.say(`#${n} PR #${obs.pr.number}: ${describe(step)}`);
    const run = (async (): Promise<void> => {
      let result: StepResult;
      try {
        result = await deps.execute(obs, step);
      } catch (error) {
        result = { signal: "step.failed", detail: error instanceof Error ? error.message : String(error) };
      }
      settle(n, step.kind, result, startedAt, describe(step));
    })().finally(() => inflight.delete(key));
    inflight.set(key, run);
  };

  const launchImplement = (agent: string): void => {
    const key = `impl:${agent}`;
    const startedAt = deps.now();
    const claim: { issue: number | null } = { issue: null };
    const run = (async (): Promise<void> => {
      let result: RunSummary | null = null;
      try {
        result = await deps.implement(agent, (issue) => {
          claim.issue = issue;
          implementing.add(issue);
        });
      } catch (error) {
        drained.add(agent); // do not hot-loop a claim error
        deps.say(`  ${agent} could not claim work: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      if (result === null) {
        drained.add(agent);
        return;
      }
      lastProgress = deps.now();
      const ok = result.outcome === "submitted";
      if (ok) summary.submitted.push(result.issue);
      else summary.failures += 1;
      deps.record({
        type: "step.finished", issue: result.issue, step: "implement", agent,
        signal: ok ? "task.submitted" : "step.failed", detail: result.outcome, durationMs: deps.now() - startedAt,
      });
      deps.say(`  #${result.issue} implement (${agent}) -> ${result.outcome}${result.prUrl ? ` ${result.prUrl}` : ""}`);
    })().finally(() => {
      if (claim.issue !== null) {
        implementing.delete(claim.issue); // finalised: the PR is now ours to drive
        settledDuringObserve.add(claim.issue); // ...but an observation already in progress predates that
      }
      inflight.delete(key);
    });
    inflight.set(key, run);
  };

  let lastBlocked = "";
  for (;;) {
    if (opts.signal?.aborted) {
      await Promise.all(inflight.values());
      summary.stopped = "aborted";
      return summary;
    }

    let tasks: TaskObservation[] = [];
    let unobserved: number[] = [];
    let ambiguous: Observation["ambiguous"] = [];
    let observed = true;
    settledDuringObserve.clear();
    try {
      ({ tasks, unobserved, ambiguous } = await deps.observe());
    } catch (error) {
      observed = false; // GitHub unreachable: say so and retry rather than concluding "nothing to do"
      deps.say(`  could not observe the board: ${error instanceof Error ? error.message : String(error)}`);
    }
    // Drop what a step that finished mid-observation has outdated; the next pass sees it fresh.
    let staleDropped = false;
    if (settledDuringObserve.size > 0 && tasks.length > 0) {
      const fresh = tasks.filter((t) => !settledDuringObserve.has(t.issue.number));
      staleDropped = fresh.length < tasks.length;
      if (staleDropped) {
        const stale = tasks.filter((t) => settledDuringObserve.has(t.issue.number)).map((t) => `#${t.issue.number}`);
        deps.say(`  ${stale.join(", ")} changed while the board was being read; observing again`);
        tasks = fresh;
      }
    }
    if (unobserved.length > 0) {
      // A PR we could not read is unknown, not finished: keep polling instead of reporting "drained".
      deps.say(`  could not observe PR${unobserved.length > 1 ? "s" : ""} ${unobserved.map((n) => `#${n}`).join(", ")}; will retry`);
    }

    const actionable: Array<{ obs: TaskObservation; step: ActionableStep }> = [];
    let waiting = !observed || unobserved.length > 0;
    // Two open PRs for one issue: driving either could merge the wrong one, and both would contend for the
    // same issue slot. The observation decides this from the full open-PR inventory (so an unreadable twin
    // still counts); an observation that nevertheless lists two tasks for one issue is treated the same way.
    const ambiguousPrs = new Map<number, number[]>(ambiguous.map((a) => [a.issue, a.prs]));
    const perIssue = new Map<number, number[]>();
    for (const t of tasks) perIssue.set(t.issue.number, [...(perIssue.get(t.issue.number) ?? []), t.pr.number]);
    for (const [n, prs] of perIssue) if (prs.length > 1) ambiguousPrs.set(n, prs);
    for (const [n, prs] of ambiguousPrs) {
      // Left to a human, reported once, and never allowed to block the loop.
      if (!summary.ambiguous.includes(n)) {
        summary.ambiguous.push(n);
        deps.say(`#${n}: ${prs.length} open PRs map to this issue (${prs.map((p) => `#${p}`).join(", ")}); not driving any of them`);
      }
    }
    for (const obs of tasks) {
      const n = obs.issue.number;
      if (ambiguousPrs.has(n)) continue;
      if (inflight.has(`issue:${n}`) || implementing.has(n)) continue;
      let step = obs.step;
      const fails = failing.get(n);
      if (fails && isActionable(step) && step.kind !== "escalate" && fails.step === describe(step) && fails.count >= MAX_STEP_FAILURES) {
        step = { kind: "escalate", reason: `${describe(step)} failed ${fails.count} times in a row (${fails.detail})` };
      }
      if (step.kind === "wait") { waiting = true; continue; }
      if (step.kind === "await-human") {
        if (!summary.awaitingHuman.includes(n)) {
          summary.awaitingHuman.push(n);
          deps.say(`#${n} PR #${obs.pr.number}: ${step.reason}`);
        }
        continue;
      }
      if (!isActionable(step)) continue;
      if (step.kind === "escalate") {
        // The first escalation is immediate (a human is already overdue); a failed one backs off and is bounded.
        if ((escalationFailures.get(n) ?? 0) >= MAX_ESCALATION_FAILURES) continue; // gave up; in the summary
        if ((escalateRetryAt.get(n) ?? 0) > deps.now()) { waiting = true; continue; }
      } else {
        const wait = retryAt.get(n);
        if (wait && wait.step === describe(step) && wait.at > deps.now()) {
          waiting = true;
          continue;
        }
      }
      actionable.push({ obs, step });
    }
    actionable.sort((a, b) => PRIORITY[a.step.kind] - PRIORITY[b.step.kind] || a.obs.issue.number - b.obs.issue.number);

    const stepsRunning = implementing.size > 0 || [...inflight.keys()].some((k) => k.startsWith("issue:"));
    if (opts.claim !== "none" && actionable.length === 0 && !stepsRunning) {
      // Routed work owned by a paused harness is not "nothing left to do": it will become runnable when
      // the cooldown ends. Wait for it (bounded by --max-idle) instead of reporting the queue drained.
      let blocked: number[] = [];
      try {
        blocked = await deps.blockedBacklog();
      } catch {
        blocked = []; // best-effort: a failed lookup must not wedge the loop
      }
      if (blocked.length > 0) {
        waiting = true;
        const key = blocked.join(",");
        if (key !== lastBlocked) {
          deps.say(`  waiting for a paused harness to resume: ${blocked.map((n) => `#${n}`).join(", ")}`);
          lastBlocked = key;
        }
      } else {
        lastBlocked = "";
      }
    }
    // Retrying a step that a paused harness refused is not new work. With --poll >= the pause backoff every
    // poll makes such a retry actionable again, so the deadline must be enforced *before* relaunching it, or
    // a cooldown that outlasts --max-idle would be retried forever. Real work (a different step, an
    // escalation) still runs: it is progress.
    const onlyPausedRetries = actionable.every((a) => a.step.kind !== "escalate" && lastUnavailable.get(a.obs.issue.number) === describe(a.step));
    if ((waiting || actionable.length > 0) && onlyPausedRetries && !stepsRunning && deps.now() - lastProgress >= opts.maxIdleMs) {
      await Promise.all(inflight.values()); // let any harness probe finish; it is short
      deps.say(`  no progress for ${Math.round((deps.now() - lastProgress) / 60_000)} min with work still waiting; stopping`);
      summary.stopped = "idle-timeout";
      return summary;
    }

    // Ctrl-C may have arrived while the reads above were pending (observe, blockedBacklog); the check at the
    // top of the loop cannot see that, and falling through here would start new merges, reviews, fixes or
    // implementations after the operator asked to stop. Nothing is dispatched past this point; only work that
    // is already running is awaited.
    if (opts.signal?.aborted) {
      await Promise.all(inflight.values());
      summary.stopped = "aborted";
      return summary;
    }

    let backlog = 0;
    for (const { obs, step } of actionable) {
      if (inflight.size < max) launchStep(obs, step);
      else backlog += 1;
    }
    if (backlog === 0 && opts.claim !== "none") {
      for (const agent of deps.availableAgents()) {
        if (inflight.size >= max) break;
        if (!drained.has(agent) && !inflight.has(`impl:${agent}`)) launchImplement(agent);
      }
    }

    if (inflight.size === 0) {
      // A task dropped as stale is not finished: look again at once instead of concluding there is nothing left.
      if (!waiting && !staleDropped) return summary; // nothing running, nothing left that could change by itself
      if (!staleDropped) await deps.sleep(opts.pollMs);
      drained.clear(); // new work may have appeared while we waited
    } else {
      await Promise.race([...inflight.values(), deps.sleep(opts.pollMs, { unref: true })]);
    }
  }
}
