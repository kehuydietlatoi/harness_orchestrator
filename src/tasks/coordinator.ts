import type { OrchConfig } from "../config.js";
import { unavailableUntil } from "../board/availability.js";
import { appendEvent, type OrchEvent } from "./events.js";
import { observeTasks, type TaskObservation } from "./observe.js";
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
  failures: number;
  stopped: "drained" | "idle-timeout" | "aborted";
}

/** All I/O the loop performs, injected so whole task lifecycles can be simulated in tests. */
export interface CoordinatorDeps {
  observe(): Promise<TaskObservation[]>;
  execute(obs: TaskObservation, step: ActionableStep): Promise<StepResult>;
  /** Claim and implement the next task routed to `agent`; null when there is nothing for it. */
  implement(agent: string): Promise<RunSummary | null>;
  availableAgents(): string[];
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
    implement: (agent) => processNext(agent, cfg, cwd, { requireRouted: true }),
    availableAgents: () => cfg.agents.filter((a) => unavailableUntil(a, cwd) === null),
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
  const summary: AutopilotSummary = { merged: [], escalated: [], submitted: [], awaitingHuman: [], failures: 0, stopped: "drained" };
  const inflight = new Map<string, Promise<void>>();
  const failing = new Map<number, { count: number; detail: string }>();
  const retryAt = new Map<number, number>();
  const drained = new Set<string>();
  /** When a step last finished or a task was last implemented. Idle time is measured from here,
   * not from "nothing in flight", because probing a harness for new work is not progress. */
  let lastProgress = deps.now();

  const settle = (issue: number, step: string, result: StepResult, startedAt: number): void => {
    lastProgress = deps.now();
    deps.record({ type: "step.finished", issue, step, signal: result.signal, detail: result.detail, durationMs: deps.now() - startedAt });
    deps.say(`  #${issue} ${step} -> ${result.signal}${result.detail ? ` (${result.detail})` : ""}`);
    switch (result.signal) {
      case "step.failed": {
        const count = (failing.get(issue)?.count ?? 0) + 1;
        failing.set(issue, { count, detail: result.detail ?? "unknown error" });
        retryAt.set(issue, deps.now() + FAILURE_BACKOFF_MS * count);
        summary.failures += 1;
        break;
      }
      case "agent.unavailable":
        retryAt.set(issue, deps.now() + Math.max(opts.pollMs, UNAVAILABLE_BACKOFF_MS));
        break;
      case "task.merged":
        summary.merged.push(issue);
        failing.delete(issue);
        drained.clear(); // a merge can unblock dependents
        break;
      case "task.escalated":
        summary.escalated.push(issue);
        break;
      default:
        failing.delete(issue);
        retryAt.delete(issue);
    }
  };

  const launchStep = (obs: TaskObservation, step: ActionableStep): void => {
    const n = obs.issue.number;
    const key = `issue:${n}`;
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
      settle(n, step.kind, result, startedAt);
    })().finally(() => inflight.delete(key));
    inflight.set(key, run);
  };

  const launchImplement = (agent: string): void => {
    const key = `impl:${agent}`;
    const startedAt = deps.now();
    const run = (async (): Promise<void> => {
      let result: RunSummary | null = null;
      try {
        result = await deps.implement(agent);
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
    })().finally(() => inflight.delete(key));
    inflight.set(key, run);
  };

  for (;;) {
    if (opts.signal?.aborted) {
      await Promise.all(inflight.values());
      summary.stopped = "aborted";
      return summary;
    }

    let tasks: TaskObservation[] = [];
    let observed = true;
    try {
      tasks = await deps.observe();
    } catch (error) {
      observed = false; // GitHub unreachable: say so and retry rather than concluding "nothing to do"
      deps.say(`  could not observe the board: ${error instanceof Error ? error.message : String(error)}`);
    }

    const actionable: Array<{ obs: TaskObservation; step: ActionableStep }> = [];
    let waiting = !observed;
    for (const obs of tasks) {
      const n = obs.issue.number;
      if (inflight.has(`issue:${n}`)) continue;
      let step = obs.step;
      const fails = failing.get(n);
      if (fails && fails.count >= MAX_STEP_FAILURES && isActionable(step) && step.kind !== "escalate") {
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
      if (step.kind !== "escalate" && (retryAt.get(n) ?? 0) > deps.now()) { waiting = true; continue; }
      actionable.push({ obs, step });
    }
    actionable.sort((a, b) => PRIORITY[a.step.kind] - PRIORITY[b.step.kind] || a.obs.issue.number - b.obs.issue.number);

    const stepsRunning = [...inflight.keys()].some((k) => k.startsWith("issue:"));
    if (waiting && actionable.length === 0 && !stepsRunning && deps.now() - lastProgress >= opts.maxIdleMs) {
      await Promise.all(inflight.values()); // let any harness probe finish; it is short
      deps.say(`  no progress for ${Math.round((deps.now() - lastProgress) / 60_000)} min with work still waiting; stopping`);
      summary.stopped = "idle-timeout";
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
      if (!waiting) return summary; // nothing running, nothing left that could change by itself
      await deps.sleep(opts.pollMs);
      drained.clear(); // new work may have appeared while we waited
    } else {
      await Promise.race([...inflight.values(), deps.sleep(opts.pollMs, { unref: true })]);
    }
  }
}
