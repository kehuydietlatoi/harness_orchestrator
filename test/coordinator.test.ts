import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_ESCALATION_FAILURES, MAX_STEP_FAILURES, runAutopilot, type ActionableStep, type AutopilotOptions, type CoordinatorDeps,
} from "../src/tasks/coordinator.js";
import type { OrchEvent } from "../src/tasks/events.js";
import type { Observation, TaskObservation } from "../src/tasks/observe.js";
import type { RunSummary } from "../src/tasks/runner.js";
import type { StepResult } from "../src/tasks/step-exec.js";
import { decideStep, type ChecksFact, type MergeableFact } from "../src/tasks/steps.js";

/** A tiny fake GitHub: PR state that the fake executors mutate and `observe` reads back. */
interface SimPr {
  issue: number;
  author: string;
  version: number;
  checks: ChecksFact;
  mergeable: MergeableFact;
  approved: boolean;
  changes: boolean;
  rounds: number;
  attention: boolean;
  merged: boolean;
  /** Lead triages recorded on the PR, and the rounds they granted. */
  triages: number;
  extraRounds: number;
  /** Verdicts the reviewer will return in order; "approve" once exhausted. */
  verdicts: Array<"approve" | "changes">;
  /** Scripted results that override the normal outcome of the next executions of a step kind. */
  overrides: Partial<Record<ActionableStep["kind"], StepResult[]>>;
}

function pr(issue: number, over: Partial<SimPr> = {}): SimPr {
  return {
    issue, author: "codex", version: 1, checks: "pass", mergeable: "clean", approved: false, changes: false,
    rounds: 0, attention: false, merged: false, triages: 0, extraRounds: 0, verdicts: [], overrides: {}, ...over,
  };
}

class World {
  prs = new Map<number, SimPr>();
  todo: Array<{ issue: number; agent: string; pr: Partial<SimPr> }> = [];
  calls: string[] = [];
  requeueOnce = false;
  events: Array<Omit<OrchEvent, "ts">> = [];
  said: string[] = [];
  active = 0;
  peak = 0;
  maxRounds = 3;
  /** Lead triages allowed per task (0: escalate straight away, the pre-triage behaviour). */
  maxTriages = 0;
  /** What the fake lead decides when it triages. */
  triageDecision: "retry" | "escalate" = "retry";
  requireHumanMerge = false;
  observeFailures = 0;
  /** The next N polls cannot read any PR (they are reported as unobserved). */
  unobservedPolls = 0;
  /** Harnesses currently on a usage-limit cooldown. */
  paused = new Set<string>();
  /** When set, `implement` opens the PR and claims the issue, then waits for this before returning. */
  implementGate?: Promise<void>;
  implementThrows = false;
  /** Called once per poll so a test can flip external state (CI finishing, a human acting). */
  onSleep?: (calls: number) => void;
  sleeps = 0;

  add(p: SimPr): SimPr { this.prs.set(p.issue, p); return p; }

  observe = async (): Promise<Observation> => {
    if (this.observeFailures > 0) { this.observeFailures -= 1; throw new Error("gh unreachable"); }
    const open = [...this.prs.values()].filter((p) => !p.merged);
    if (this.unobservedPolls > 0) {
      this.unobservedPolls -= 1;
      return { tasks: [], unobserved: open.map((p) => 1000 + p.issue), ambiguous: [] };
    }
    const tasks = open.map((p) => {
      const facts = {
        attention: p.attention,
        pr: { number: 1000 + p.issue, head: `h${p.version}`, checks: p.checks, mergeable: p.mergeable },
        review: { approved: p.approved, changesRequested: p.changes },
        rounds: p.rounds, maxRounds: this.maxRounds, requireHumanMerge: this.requireHumanMerge,
        triages: p.triages, maxTriages: this.maxTriages, extraRounds: p.extraRounds,
      };
      return {
        issue: { number: p.issue, title: `t${p.issue}`, body: "", state: "OPEN", labels: [], assignees: [] },
        author: p.author,
        pr: { number: 1000 + p.issue, title: "", body: "", state: "OPEN", headSha: `h${p.version}`, headRefName: `task/${p.issue}-x`, htmlUrl: "" },
        reviews: [], facts, step: decideStep(facts), feedback: p.changes ? "please fix" : null,
      } as TaskObservation;
    });
    return { tasks, unobserved: [], ambiguous: [] };
  };

  execute = async (obs: TaskObservation, step: ActionableStep): Promise<StepResult> => {
    const p = this.prs.get(obs.issue.number) as SimPr;
    this.calls.push(`${step.kind === "fix" ? `fix:${step.reason}` : step.kind}:${p.issue}`);
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    await Promise.resolve();
    this.active -= 1;
    const scripted = p.overrides[step.kind]?.shift();
    if (scripted) return scripted;
    switch (step.kind) {
      case "review": {
        if ((p.verdicts.shift() ?? "approve") === "approve") { p.approved = true; return { signal: "review.approved" }; }
        p.changes = true;
        return { signal: "review.changes_requested" };
      }
      case "fix":
        p.version += 1; p.changes = false; p.approved = false; p.rounds += 1; p.checks = "pass";
        return { signal: "fix.pushed" };
      case "resolve-conflict":
        p.version += 1; p.mergeable = "clean"; p.approved = false; p.rounds += 1;
        return { signal: "conflict.resolved" };
      case "merge":
        p.merged = true;
        return { signal: "task.merged" };
      case "triage":
        p.triages += 1;
        if (this.triageDecision === "retry") { p.extraRounds += 1; return { signal: "triage.retry" }; }
        p.attention = true;
        return { signal: "task.escalated", detail: `${step.reason}. Lead triage: needs a human` };
      case "escalate":
        p.attention = true;
        return { signal: "task.escalated", detail: step.reason };
    }
  };

  implement = async (agent: string, onClaimed: (issue: number) => void = () => undefined): Promise<RunSummary | null> => {
    if (this.implementThrows) throw new Error("claim exploded");
    const i = this.todo.findIndex((t) => t.agent === agent && !this.paused.has(agent));
    if (i < 0) return null;
    const [t] = this.todo.splice(i, 1);
    this.calls.push(`implement:${agent}:${t.issue}`);
    onClaimed(t.issue);
    if (this.requeueOnce) {
      // The harness ran out of usage mid-run: the task is back in the queue and the harness is paused.
      this.requeueOnce = false;
      this.paused.add(agent);
      this.todo.unshift(t);
      return { issue: t.issue, outcome: "requeued", durationMs: 1 };
    }
    this.add(pr(t.issue, { author: agent, ...t.pr })); // the agent ran `orch submit` itself
    if (this.implementGate) await this.implementGate; // ...but its process has not finished yet
    return { issue: t.issue, outcome: "submitted", durationMs: 1, prUrl: `https://example/pull/${1000 + t.issue}` };
  };

  deps = (): CoordinatorDeps => ({
    observe: this.observe,
    execute: this.execute,
    implement: this.implement,
    availableAgents: () => ["claude", "codex"].filter((a) => !this.paused.has(a)),
    blockedBacklog: async () => this.todo.filter((t) => this.paused.has(t.agent)).map((t) => t.issue),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    record: (e) => { this.events.push(e); },
    say: (line) => { this.said.push(line); },
  });
}

const OPTS: AutopilotOptions = { max: 2, pollMs: 1000, maxIdleMs: 5 * 60_000 };

/** Run the loop to completion under fake timers (1 virtual second per step), failing on a runaway. */
async function drive(world: World, opts: Partial<AutopilotOptions> = {}) {
  let done = false;
  const run = runAutopilot({ ...OPTS, ...opts }, world.deps()).finally(() => { done = true; });
  for (let i = 0; i < 2000 && !done; i += 1) {
    await vi.advanceTimersByTimeAsync(1000);
    world.sleeps += 1;
    world.onSleep?.(world.sleeps);
  }
  expect(done, "the loop must terminate").toBe(true);
  return run;
}

describe("runAutopilot", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("drives a task from implementation through review feedback, a resumed fix, and merge", async () => {
    const w = new World();
    w.todo.push({ issue: 38, agent: "claude", pr: { author: "claude", verdicts: ["changes", "approve"] } });

    const summary = await drive(w);

    expect(w.calls).toEqual(["implement:claude:38", "review:38", "fix:review:38", "review:38", "merge:38"]);
    expect(summary).toMatchObject({ merged: [38], submitted: [38], escalated: [], awaitingHuman: [], failures: 0, stopped: "drained" });
    const signals = w.events.filter((e) => e.type === "step.finished").map((e) => `${e.step}:${e.signal}`);
    expect(signals).toEqual([
      "implement:task.submitted", "review:review.changes_requested", "fix:fix.pushed", "review:review.approved", "merge:task.merged",
    ]);
  });

  it("resolves a conflict before reviewing, then reviews the new head and merges", async () => {
    const w = new World();
    w.add(pr(38, { mergeable: "conflicting" }));

    await drive(w);

    expect(w.calls).toEqual(["resolve-conflict:38", "review:38", "merge:38"]);
  });

  it("sends a red CI back to the author as a fix", async () => {
    const w = new World();
    w.add(pr(38, { checks: "fail", approved: true }));

    await drive(w);

    expect(w.calls).toEqual(["fix:ci:38", "review:38", "merge:38"]);
  });

  it("escalates to a human once the round budget is spent and never merges", async () => {
    const w = new World();
    w.maxRounds = 2;
    w.add(pr(38, { verdicts: ["changes", "changes", "changes", "changes"] }));

    const summary = await drive(w);

    expect(w.calls).toEqual(["review:38", "fix:review:38", "review:38", "fix:review:38", "review:38", "escalate:38"]);
    expect(summary).toMatchObject({ merged: [], escalated: [38], stopped: "drained" });
    expect(w.prs.get(38)?.attention).toBe(true);
  });

  it("leaves an escalated task alone afterwards", async () => {
    const w = new World();
    w.add(pr(38, { attention: true, changes: true }));
    const summary = await drive(w);
    expect(w.calls).toEqual([]);
    expect(summary.merged).toEqual([]);
  });

  it("retries a failed step after a backoff, then escalates after repeated failures", async () => {
    const w = new World();
    const failed: StepResult = { signal: "step.failed", detail: "no new commits" };
    w.add(pr(38, { changes: true, overrides: { fix: [failed, failed, failed] } }));

    const summary = await drive(w);

    expect(w.calls).toEqual(["fix:review:38", "fix:review:38", "escalate:38"]);
    expect(MAX_STEP_FAILURES).toBe(2);
    expect(summary).toMatchObject({ escalated: [38], failures: 2 });
    expect(w.events.find((e) => e.signal === "task.escalated")?.detail).toContain("failed 2 times in a row (no new commits)");
  });

  it("recovers when a failed step succeeds on retry", async () => {
    const w = new World();
    w.add(pr(38, { changes: true, overrides: { fix: [{ signal: "step.failed", detail: "flaky" }] } }));

    const summary = await drive(w);

    expect(w.calls).toEqual(["fix:review:38", "fix:review:38", "review:38", "merge:38"]);
    expect(summary).toMatchObject({ merged: [38], escalated: [], failures: 1 });
  });

  it("waits out an unavailable harness without counting it as a failure", async () => {
    const w = new World();
    w.add(pr(38, { overrides: { review: [{ signal: "agent.unavailable", detail: "all harnesses paused" }] } }));

    const summary = await drive(w);

    expect(w.calls).toEqual(["review:38", "review:38", "merge:38"]);
    expect(summary).toMatchObject({ merged: [38], failures: 0 });
  });

  it("stops at an approved, green PR when a human must merge", async () => {
    const w = new World();
    w.requireHumanMerge = true;
    w.add(pr(38));

    const summary = await drive(w);

    expect(w.calls).toEqual(["review:38"]);
    expect(summary).toMatchObject({ merged: [], awaitingHuman: [38], stopped: "drained" });
  });

  it("waits for CI to finish before merging an approved PR", async () => {
    const w = new World();
    w.add(pr(38, { approved: true, checks: "pending" }));
    w.onSleep = (n) => { if (n === 3) w.prs.get(38)!.checks = "pass"; };

    const summary = await drive(w);

    expect(w.calls).toEqual(["merge:38"]);
    expect(summary.merged).toEqual([38]);
    expect(w.sleeps).toBeGreaterThanOrEqual(3);
  });

  it("gives up with an idle timeout when external state never settles", async () => {
    const w = new World();
    w.add(pr(38, { approved: true, checks: "pending" }));

    const summary = await drive(w, { maxIdleMs: 10_000 });

    expect(summary.stopped).toBe("idle-timeout");
    expect(w.calls).toEqual([]);
  });

  it("keeps retrying when the board cannot be observed, rather than concluding it is empty", async () => {
    const w = new World();
    w.observeFailures = 3;
    w.add(pr(38, { approved: true }));

    const summary = await drive(w);

    expect(summary.merged).toEqual([38]);
    expect(w.said.some((l) => l.includes("could not observe the board"))).toBe(true);
  });

  it("gives up on a persistently paused harness once --max-idle passes, instead of retrying forever", async () => {
    const w = new World();
    const paused: StepResult = { signal: "agent.unavailable", detail: "all harnesses paused" };
    w.add(pr(38, { overrides: { review: Array.from({ length: 20 }, () => paused) } }));

    // The pause backoff is 60s, so with a 90s idle limit the loop may retry exactly once (t=60s) and
    // must stop at t=120s. If a refusal counted as progress it would reset the timer on every retry.
    const summary = await drive(w, { maxIdleMs: 90_000 });

    expect(summary.stopped).toBe("idle-timeout");
    expect(w.calls).toEqual(["review:38", "review:38"]);
    expect(summary.failures).toBe(0);
  });

  it("still counts a real step as progress, so a slow but advancing task is not abandoned", async () => {
    const w = new World();
    w.add(pr(38, { verdicts: ["changes", "changes", "approve"], overrides: { review: [{ signal: "agent.unavailable" }] } }));

    const summary = await drive(w, { maxIdleMs: 90_000 });

    expect(summary.merged).toEqual([38]);
    expect(summary.stopped).toBe("drained");
  });

  it("keeps polling when a PR could not be read, even with nothing else to do (--no-claim)", async () => {
    const w = new World();
    w.add(pr(38, { approved: true }));
    w.unobservedPolls = 3; // a transient lookup failure on the only PR, for three polls

    const summary = await drive(w, { claim: "none" });

    expect(summary).toMatchObject({ merged: [38], stopped: "drained" });
    expect(w.said.some((l) => l.includes("could not observe PR #1038; will retry"))).toBe(true);
    expect(w.sleeps).toBeGreaterThanOrEqual(3);
  });

  it("does not report drained while a PR stays unreadable; it times out instead", async () => {
    const w = new World();
    w.add(pr(38, { approved: true }));
    w.unobservedPolls = Number.MAX_SAFE_INTEGER;

    const summary = await drive(w, { claim: "none", maxIdleMs: 10_000 });

    expect(summary.stopped).toBe("idle-timeout");
    expect(summary.merged).toEqual([]);
  });

  describe("a PR the agent opened itself while its implementation is still running", () => {
    it("is left alone until the implementation has finalised, then driven normally", async () => {
      const w = new World();
      let release!: () => void;
      w.implementGate = new Promise<void>((resolve) => { release = resolve; });
      w.todo.push({ issue: 7, agent: "claude", pr: { author: "claude", approved: true } }); // ready to merge

      let done = false;
      const run = runAutopilot({ ...OPTS, max: 2, claim: "routed" }, w.deps()).finally(() => { done = true; });
      for (let i = 0; i < 30; i += 1) await vi.advanceTimersByTimeAsync(1000); // many polls while it is "still running"

      // The PR exists and is mergeable, but the agent process has not returned: do not touch it.
      expect(w.calls).toEqual(["implement:claude:7"]);
      expect(done).toBe(false);

      release();
      for (let i = 0; i < 200 && !done; i += 1) await vi.advanceTimersByTimeAsync(1000);
      expect(done).toBe(true);
      expect(w.calls).toEqual(["implement:claude:7", "merge:7"]);
      expect(await run).toMatchObject({ submitted: [7], merged: [7] });
    });

    it("does not stop other tasks from being driven in the meantime", async () => {
      const w = new World();
      let release!: () => void;
      w.implementGate = new Promise<void>((resolve) => { release = resolve; });
      w.todo.push({ issue: 7, agent: "claude", pr: { author: "claude", approved: true } });
      w.add(pr(9, { approved: true }));

      let done = false;
      const run = runAutopilot({ ...OPTS, max: 3, claim: "routed" }, w.deps()).finally(() => { done = true; });
      for (let i = 0; i < 30; i += 1) await vi.advanceTimersByTimeAsync(1000);
      expect(w.calls).toContain("merge:9");
      expect(w.calls).not.toContain("merge:7");

      release();
      for (let i = 0; i < 200 && !done; i += 1) await vi.advanceTimersByTimeAsync(1000);
      await run;
      expect(w.calls).toContain("merge:7");
    });
  });

  describe("routed work owned by a paused harness", () => {
    it("waits for the task's owner to resume instead of reporting the queue drained (only the owner paused)", async () => {
      const w = new World();
      w.paused.add("claude"); // codex is available but has nothing queued
      w.todo.push({ issue: 7, agent: "claude", pr: { author: "claude", approved: true } });
      w.onSleep = (n) => { if (n === 4) w.paused.delete("claude"); };

      const summary = await drive(w);

      expect(w.calls).toEqual(["implement:claude:7", "merge:7"]);
      expect(summary).toMatchObject({ merged: [7], stopped: "drained" });
      expect(w.said.some((l) => l.includes("waiting for a paused harness to resume: #7"))).toBe(true);
    });

    it("waits when every harness is paused and a routed task is queued", async () => {
      const w = new World();
      w.paused.add("claude");
      w.paused.add("codex");
      w.todo.push({ issue: 7, agent: "codex", pr: { approved: true } });
      w.onSleep = (n) => { if (n === 3) { w.paused.clear(); } };

      const summary = await drive(w);

      expect(summary.merged).toEqual([7]);
      expect(w.calls[0]).toBe("implement:codex:7");
    });

    it("a run that died on a usage limit is requeued, not counted as a failure, and runs again after the pause", async () => {
      const w = new World();
      w.requeueOnce = true;
      w.todo.push({ issue: 7, agent: "claude", pr: { author: "claude", approved: true } });
      w.onSleep = (n) => { if (n >= 4) w.paused.delete("claude"); };

      const summary = await drive(w);

      expect(w.calls).toEqual(["implement:claude:7", "implement:claude:7", "merge:7"]);
      expect(summary).toMatchObject({ merged: [7], submitted: [7], failures: 0, escalated: [], stopped: "drained" });
      expect(w.events.find((e) => e.type === "step.finished" && e.step === "implement")).toMatchObject({
        signal: "agent.unavailable", detail: "requeued",
      });
    });

    it("gives up after --max-idle when the owner never resumes, leaving the task queued", async () => {
      const w = new World();
      w.paused.add("claude");
      w.todo.push({ issue: 7, agent: "claude", pr: {} });

      const summary = await drive(w, { maxIdleMs: 10_000 });

      expect(summary.stopped).toBe("idle-timeout");
      expect(w.todo).toHaveLength(1);
      expect(w.calls).toEqual([]);
    });

    it("is not waited on when the loop must not claim anything (--no-claim)", async () => {
      const w = new World();
      w.paused.add("claude");
      w.todo.push({ issue: 7, agent: "claude", pr: {} });

      const summary = await drive(w, { claim: "none" });

      expect(summary.stopped).toBe("drained");
      expect(w.todo).toHaveLength(1);
    });

    it("does not wait when nothing queued belongs to a paused harness", async () => {
      const w = new World();
      w.paused.add("codex"); // the queued task is claude's, and claude is available
      w.todo.push({ issue: 7, agent: "claude", pr: { author: "claude", approved: true } });

      const summary = await drive(w);

      expect(summary).toMatchObject({ merged: [7], stopped: "drained" });
    });
  });

  it("leaves an issue with two open PRs alone instead of driving either, and does not block the loop", async () => {
    const w = new World();
    w.add(pr(38, { approved: true })); // would merge if it were unambiguous
    const deps = w.deps();
    // Live, not static: if a step did run, the world would change and the loop could end, so a
    // regression fails on the assertions below rather than spinning forever.
    deps.observe = async () => {
      const [only] = (await w.observe()).tasks;
      return {
        tasks: only ? [only, { ...only, pr: { ...only.pr, number: 2000, headRefName: "task/38-duplicate" } }] : [],
        unobserved: [],
        ambiguous: [],
      };
    };

    let done = false;
    const run = runAutopilot(OPTS, deps).finally(() => { done = true; });
    for (let i = 0; i < 100 && !done; i += 1) await vi.advanceTimersByTimeAsync(1000);

    expect(done).toBe(true);
    expect(w.calls).toEqual([]);
    expect(await run).toMatchObject({ ambiguous: [38], merged: [], stopped: "drained" });
    expect(w.said.filter((l) => l.includes("2 open PRs map to this issue"))).toHaveLength(1); // reported once
  });

  it("still drives other issues while one is ambiguous", async () => {
    const w = new World();
    w.add(pr(38, { approved: true }));
    w.add(pr(40, { approved: true }));
    const deps = w.deps();
    deps.observe = async () => {
      const live = await w.observe();
      const t38 = live.tasks.find((t) => t.issue.number === 38); // the duplicate exists only while #38 is open
      return { tasks: t38 ? [...live.tasks, { ...t38, pr: { ...t38.pr, number: 2000 } }] : live.tasks, unobserved: [], ambiguous: [] };
    };

    let done = false;
    const run = runAutopilot(OPTS, deps).finally(() => { done = true; });
    for (let i = 0; i < 100 && !done; i += 1) await vi.advanceTimersByTimeAsync(1000);

    expect(w.calls).toEqual(["merge:40"]);
    expect(await run).toMatchObject({ ambiguous: [38], merged: [40] });
  });

  describe("retrying a paused harness", () => {
    const paused: StepResult = { signal: "agent.unavailable", detail: "all harnesses paused" };

    it("enforces --max-idle before relaunching the retry, even when --poll is as long as the pause", async () => {
      const w = new World();
      w.add(pr(38, { overrides: { review: Array.from({ length: 50 }, () => paused) } }));

      // pollMs (60s) >= the pause backoff (60s), so EVERY poll makes the retry actionable again. Retries are
      // not progress, so with a 150s limit the loop must stop at t=180s after attempts at 0s, 60s and 120s.
      const summary = await drive(w, { pollMs: 60_000, maxIdleMs: 150_000 });

      expect(summary.stopped).toBe("idle-timeout");
      expect(w.calls).toEqual(["review:38", "review:38", "review:38"]);
      expect(summary.failures).toBe(0);
    });

    it("still retries after the pause when there is time left, and finishes the task", async () => {
      const w = new World();
      w.add(pr(38, { overrides: { review: [paused, paused] } }));

      const summary = await drive(w, { pollMs: 60_000, maxIdleMs: 30 * 60_000 });

      expect(w.calls).toEqual(["review:38", "review:38", "review:38", "merge:38"]);
      expect(summary).toMatchObject({ merged: [38], stopped: "drained" });
    });

    it("does not delay an unrelated step on the same issue behind a retry timer (a merge after a manual approval)", async () => {
      const w = new World();
      w.add(pr(38, { overrides: { review: [paused] } })); // the review is refused: it is backed off for 60s
      w.onSleep = (n) => { if (n === 2) w.prs.get(38)!.approved = true; }; // approved by hand at t=2s
      const deps = w.deps();
      const inner = deps.execute;
      const started = Date.now();
      let mergeAt = -1;
      deps.execute = async (obs, step) => {
        if (step.kind === "merge") mergeAt = Date.now() - started;
        return inner(obs, step);
      };

      let done = false;
      const run = runAutopilot(OPTS, deps).finally(() => { done = true; });
      for (let i = 0; i < 2000 && !done; i += 1) {
        await vi.advanceTimersByTimeAsync(1000);
        w.sleeps += 1;
        w.onSleep?.(w.sleeps);
      }

      expect(done).toBe(true);
      expect(await run).toMatchObject({ merged: [38] });
      // A merge needs no agent, so the review's 60s pause must not hold it back.
      expect(mergeAt).toBeGreaterThanOrEqual(0);
      expect(mergeAt).toBeLessThan(30_000);
    });

    it("does not let the idle deadline cut off real work that became actionable meanwhile", async () => {
      const w = new World();
      w.add(pr(38, { overrides: { review: [paused] } }));
      // Someone approves the PR by hand while the harness is paused: the next step is a merge, which is progress.
      w.onSleep = (n) => { if (n === 2) w.prs.get(38)!.approved = true; };

      const summary = await drive(w, { pollMs: 60_000, maxIdleMs: 60_000 });

      expect(w.calls).toEqual(["review:38", "merge:38"]);
      expect(summary).toMatchObject({ merged: [38], stopped: "drained" });
    });
  });

  describe("failure counts belong to a step, not to an issue", () => {
    const failed = (detail: string): StepResult => ({ signal: "step.failed", detail });

    it("does not escalate a failed review followed by an external approval and ONE failed merge", async () => {
      const w = new World();
      w.add(pr(38, { overrides: { review: [failed("verdict unparseable")], merge: [failed("gate refused")] } }));
      const deps = w.deps();
      const inner = deps.execute;
      deps.execute = async (obs, step) => {
        const result = await inner(obs, step);
        if (step.kind === "review" && result.signal === "step.failed") w.prs.get(38)!.approved = true; // approved by hand
        return result;
      };

      let done = false;
      const run = runAutopilot(OPTS, deps).finally(() => { done = true; });
      for (let i = 0; i < 2000 && !done; i += 1) await vi.advanceTimersByTimeAsync(1000);

      expect(done).toBe(true);
      expect(w.calls).toEqual(["review:38", "merge:38", "merge:38"]);
      expect(await run).toMatchObject({ merged: [38], escalated: [], failures: 2 });
    });

    it("still escalates when the SAME step fails repeatedly", async () => {
      const w = new World();
      w.add(pr(38, { approved: true, overrides: { merge: [failed("gate refused"), failed("gate refused")] } }));

      const summary = await drive(w);

      expect(w.calls).toEqual(["merge:38", "merge:38", "escalate:38"]);
      expect(summary).toMatchObject({ escalated: [38], merged: [] });
    });

    it("treats a fix for review feedback and a fix for CI as different steps", async () => {
      const w = new World();
      w.add(pr(38, { changes: true, overrides: { fix: [failed("no new commits")] } }));
      const deps = w.deps();
      const inner = deps.execute;
      deps.execute = async (obs, step) => {
        const result = await inner(obs, step);
        if (step.kind === "fix" && step.reason === "review" && result.signal === "step.failed") {
          const p = w.prs.get(38)!; // the review feedback is withdrawn and CI goes red instead
          p.changes = false; p.checks = "fail";
        }
        return result;
      };
      w.prs.get(38)!.overrides.fix = [failed("no new commits"), failed("flaky")];

      let done = false;
      const run = runAutopilot(OPTS, deps).finally(() => { done = true; });
      for (let i = 0; i < 2000 && !done; i += 1) await vi.advanceTimersByTimeAsync(1000);

      expect(done).toBe(true);
      expect(w.calls.slice(0, 2)).toEqual(["fix:review:38", "fix:ci:38"]);
      expect((await run).escalated).toEqual([]); // two failures, but of two different steps
    });
  });

  describe("ambiguity decided from the full PR inventory", () => {
    it("never merges a readable duplicate just because its twin could not be loaded", async () => {
      const w = new World();
      w.add(pr(38, { approved: true })); // the readable, approved twin: would merge if it looked unique
      const deps = w.deps();
      deps.observe = async () => ({
        tasks: (await w.observe()).tasks, // observeTasks may still hand back the twin it could read...
        unobserved: [],
        ambiguous: [{ issue: 38, prs: [1038, 2000] }], // ...but the inventory says two PRs map to #38
      });

      let done = false;
      const run = runAutopilot(OPTS, deps).finally(() => { done = true; });
      for (let i = 0; i < 100 && !done; i += 1) await vi.advanceTimersByTimeAsync(1000);

      expect(done).toBe(true);
      expect(w.calls).toEqual([]); // nothing was driven, and in particular nothing merged
      expect(await run).toMatchObject({ ambiguous: [38], merged: [], stopped: "drained" });
      expect(w.said.some((l) => l.includes("2 open PRs map to this issue (#1038, #2000)"))).toBe(true);
    });

    it("reports an ambiguous issue even when none of its PRs was observed", async () => {
      const w = new World();
      const deps = w.deps();
      deps.observe = async () => ({ tasks: [], unobserved: [], ambiguous: [{ issue: 7, prs: [70, 71] }] });

      const summary = await runAutopilot(OPTS, deps);

      expect(summary).toMatchObject({ ambiguous: [7], stopped: "drained" });
    });
  });

  describe("an observation that predates a step finishing", () => {
    /** Hold the Nth observation open after it has read the board, so a step can finish before it returns. */
    function gatedObserve(w: World, which: number) {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const deps = w.deps();
      const inner = deps.observe;
      const state = { calls: 0 };
      deps.observe = async () => {
        const snapshot = await inner(); // reads the world NOW...
        state.calls += 1;
        if (state.calls === which) await gate; // ...and only returns after a step has finished
        return snapshot;
      };
      return { deps, state, release };
    }
    const tick = async (n: number) => { for (let i = 0; i < n; i += 1) await vi.advanceTimersByTimeAsync(1000); };

    it("does not launch a second fix from feedback the first fix already addressed", async () => {
      const w = new World();
      w.add(pr(38, { changes: true }));
      let releaseFix!: () => void;
      const fixGate = new Promise<void>((resolve) => { releaseFix = resolve; });
      const { deps, state, release: releaseObserve } = gatedObserve(w, 2);
      const innerExecute = deps.execute;
      let firstFix = true;
      deps.execute = async (obs, step) => {
        if (step.kind === "fix" && firstFix) { firstFix = false; await fixGate; } // the fix is "running"
        return innerExecute(obs, step);
      };

      let done = false;
      const run = runAutopilot(OPTS, deps).finally(() => { done = true; });
      for (let i = 0; i < 20 && state.calls < 2; i += 1) await tick(1);
      expect(state.calls).toBe(2); // the 2nd observation has captured the world (feedback outstanding, old head)...
      expect(w.calls).toEqual([]); // ...while the first fix is still running

      releaseFix(); // the fix finishes: new head, feedback addressed
      await vi.advanceTimersByTimeAsync(10);
      releaseObserve(); // only now does the stale observation come back
      for (let i = 0; i < 500 && !done; i += 1) await tick(1);

      expect(done).toBe(true);
      // One fix, then a review of the NEW head, then the merge. A stale observation would have launched fix #2.
      expect(w.calls).toEqual(["fix:review:38", "review:38", "merge:38"]);
      expect(await run).toMatchObject({ merged: [38], stopped: "drained" });
      expect(w.said.some((l) => l.includes("#38 changed while the board was being read; observing again"))).toBe(true);
    });

    it("is not mistaken for 'nothing left to do': the loop observes again instead of reporting drained", async () => {
      const w = new World();
      w.add(pr(38, { changes: true }));
      let releaseFix!: () => void;
      const fixGate = new Promise<void>((resolve) => { releaseFix = resolve; });
      const { deps, state, release: releaseObserve } = gatedObserve(w, 2);
      const innerExecute = deps.execute;
      let firstFix = true;
      deps.execute = async (obs, step) => {
        if (step.kind === "fix" && firstFix) { firstFix = false; await fixGate; }
        return innerExecute(obs, step);
      };

      let done = false;
      const run = runAutopilot({ ...OPTS, claim: "none" }, deps).finally(() => { done = true; });
      for (let i = 0; i < 20 && state.calls < 2; i += 1) await tick(1);
      releaseFix();
      await vi.advanceTimersByTimeAsync(10);
      releaseObserve();
      for (let i = 0; i < 500 && !done; i += 1) await tick(1);

      // The stale task was dropped and nothing else was running; returning here would strand the PR unmerged.
      expect((await run).merged).toEqual([38]);
    });

    it("also drops a task whose implementation finalised mid-observation (it may still have been pushing)", async () => {
      const w = new World();
      let releaseImplement!: () => void;
      w.implementGate = new Promise<void>((resolve) => { releaseImplement = resolve; });
      w.todo.push({ issue: 7, agent: "claude", pr: { author: "claude", approved: true } });
      const { deps, state, release: releaseObserve } = gatedObserve(w, 2);

      let done = false;
      const run = runAutopilot(OPTS, deps).finally(() => { done = true; });
      for (let i = 0; i < 20 && state.calls < 2; i += 1) await tick(1);
      expect(state.calls).toBe(2); // observed while the agent was still implementing (and had already opened its PR)

      releaseImplement(); // the implementation finalises
      await vi.advanceTimersByTimeAsync(10);
      releaseObserve();
      for (let i = 0; i < 500 && !done; i += 1) await tick(1);

      expect(done).toBe(true);
      expect(w.said.some((l) => l.includes("#7 changed while the board was being read"))).toBe(true);
      expect(await run).toMatchObject({ submitted: [7], merged: [7] });
    });

    it("leaves tasks that did not change alone, so unrelated work is not delayed", async () => {
      const w = new World();
      w.add(pr(38, { changes: true }));
      w.add(pr(40, { approved: true, checks: "pending" })); // not mergeable yet at the first observation
      let releaseFix!: () => void;
      const fixGate = new Promise<void>((resolve) => { releaseFix = resolve; });
      const { deps, state, release: releaseObserve } = gatedObserve(w, 2);
      const gated = deps.observe;
      deps.observe = async () => {
        const seen = await gated();
        if (state.calls === 1) w.prs.get(40)!.checks = "pass"; // CI goes green after the 1st observation, before the 2nd
        return seen;
      };
      const innerExecute = deps.execute;
      let firstFix = true;
      let observationsWhenMerging40 = -1;
      deps.execute = async (obs, step) => {
        if (step.kind === "fix" && firstFix) { firstFix = false; await fixGate; }
        if (step.kind === "merge" && obs.issue.number === 40) observationsWhenMerging40 = state.calls;
        return innerExecute(obs, step);
      };

      let done = false;
      const run = runAutopilot({ ...OPTS, max: 3 }, deps).finally(() => { done = true; });
      for (let i = 0; i < 20 && state.calls < 2; i += 1) await tick(1);
      releaseFix();
      await vi.advanceTimersByTimeAsync(10);
      releaseObserve();
      for (let i = 0; i < 500 && !done; i += 1) await tick(1);

      expect(w.calls.filter((c) => c === "fix:review:38")).toHaveLength(1);
      expect(await run).toMatchObject({ merged: expect.arrayContaining([38, 40]) });
      // #40 became ready exactly at the stale (2nd) observation and did not change during it, so it is merged
      // from that very pass instead of being dropped and held back for a third observation.
      expect(observationsWhenMerging40).toBe(2);
    });
  });

  describe("a human hands an escalated task back while the loop is still running", () => {
    const failed: StepResult = { signal: "step.failed", detail: "no new commits" };

    it("tries the original step again instead of re-escalating on the old failure count", async () => {
      const w = new World();
      w.add(pr(38, { changes: true, overrides: { fix: [failed, failed] } })); // two failed fixes -> escalated
      w.add(pr(39, { approved: true, checks: "pending" })); // keeps the loop alive while the human decides
      w.onSleep = (n) => {
        if (n === 100) w.prs.get(38)!.attention = false; // the human removes `needs-attention`
        if (n === 200) w.prs.get(39)!.checks = "pass";
      };

      const summary = await drive(w);

      // Fixed twice (both fail), escalated once, then - after the handback - the fix is simply tried again and
      // works, and the task goes on to review and merge. It is not escalated a second time.
      expect(w.calls).toEqual([
        "fix:review:38", "fix:review:38", "escalate:38", "fix:review:38", "review:38", "merge:38", "merge:39",
      ]);
      expect(summary).toMatchObject({ escalated: [38], merged: [38, 39], stopped: "drained" });
    });

    it("does not make the handed-back step wait out a retry timer left over from before the escalation", async () => {
      const w = new World();
      w.maxRounds = 1;
      w.add(pr(38, { changes: true, overrides: { fix: [failed] } })); // the first fix fails: backed off for 30s
      w.add(pr(39, { approved: true, checks: "pending" })); // keeps the loop alive meanwhile
      w.onSleep = (n) => {
        if (n === 5) w.prs.get(38)!.rounds = 1; // the budget is now spent -> escalate (long before the 30s is up)
        if (n === 10) { const p = w.prs.get(38)!; p.attention = false; p.rounds = 0; } // handed back, fresh budget
        if (n === 120) w.prs.get(39)!.checks = "pass";
      };
      const deps = w.deps();
      const inner = deps.execute;
      const started = Date.now();
      const fixAt: number[] = [];
      deps.execute = async (obs, step) => {
        if (step.kind === "fix") fixAt.push(Date.now() - started);
        return inner(obs, step);
      };

      let done = false;
      const run = runAutopilot(OPTS, deps).finally(() => { done = true; });
      for (let i = 0; i < 2000 && !done; i += 1) {
        await vi.advanceTimersByTimeAsync(1000);
        w.sleeps += 1;
        w.onSleep?.(w.sleeps);
      }

      expect(done).toBe(true);
      expect(w.calls.slice(0, 3)).toEqual(["fix:review:38", "escalate:38", "fix:review:38"]);
      // The first fix backed off until t=30s, but after the escalation and handback that timer is gone.
      expect(fixAt[1]).toBeLessThan(20_000);
      expect((await run).escalated).toEqual([38]);
    });
  });

  describe("escalation that itself fails", () => {
    const failed: StepResult = { signal: "step.failed", detail: "label write failed" };
    /** A task that must escalate (its one allowed fix round is spent), whose escalation writes then fail. */
    function stuck(n: number, failures: number): World {
      const w = new World();
      w.maxRounds = 1;
      w.add(pr(38, { changes: true, rounds: 1, overrides: { escalate: Array.from({ length: n }, () => failed).slice(0, failures) } }));
      return w;
    }
    const timed = (w: World) => {
      const times: number[] = [];
      const deps = w.deps();
      const inner = deps.execute;
      deps.execute = async (obs, step) => { if (step.kind === "escalate") times.push(Date.now()); return inner(obs, step); };
      return { deps, times };
    };
    const driveWith = async (deps: CoordinatorDeps, opts: Partial<AutopilotOptions> = {}) => {
      let done = false;
      const run = runAutopilot({ ...OPTS, ...opts }, deps).finally(() => { done = true; });
      for (let i = 0; i < 2000 && !done; i += 1) await vi.advanceTimersByTimeAsync(1000);
      expect(done, "the loop must terminate").toBe(true);
      return run;
    };

    it("backs off between attempts and gives up after a bound, reporting it instead of retrying forever", async () => {
      const w = stuck(50, 50);
      const { deps, times } = timed(w);

      const summary = await driveWith(deps);

      expect(w.calls).toEqual(["escalate:38", "escalate:38", "escalate:38"]); // MAX_ESCALATION_FAILURES, not unbounded
      expect(MAX_ESCALATION_FAILURES).toBe(3);
      expect(times[1] - times[0]).toBeGreaterThanOrEqual(30_000); // backoff grows with each failure
      expect(times[2] - times[1]).toBeGreaterThanOrEqual(60_000);
      expect(summary).toMatchObject({ escalated: [], escalationFailed: [38], failures: 3, stopped: "drained" });
      expect(w.said.some((l) => l.includes("could not be escalated after 3 attempts"))).toBe(true);
    });

    it("does not treat a failing escalation as progress, so --max-idle still ends the wait", async () => {
      const w = stuck(50, 50);
      const { deps } = timed(w);

      // Retries come at t=0, 30s and 90s. With a 75s idle limit the loop must stop before the third; if a
      // failed escalation reset the idle clock it would reach the third attempt and finish as "drained".
      const summary = await driveWith(deps, { maxIdleMs: 75_000 });

      expect(summary.stopped).toBe("idle-timeout");
      expect(w.calls).toEqual(["escalate:38", "escalate:38"]);
    });

    it("recovers: a later escalation that works clears the failures and escalates normally", async () => {
      const w = stuck(1, 1); // only the first attempt fails
      const { deps } = timed(w);

      const summary = await driveWith(deps);

      expect(w.calls).toEqual(["escalate:38", "escalate:38"]);
      expect(summary).toMatchObject({ escalated: [38], escalationFailed: [], stopped: "drained" });
    });

    it("escalates immediately the first time, without waiting out earlier step-failure backoff", async () => {
      const w = new World();
      const fail: StepResult = { signal: "step.failed", detail: "no new commits" };
      w.add(pr(38, { changes: true, overrides: { fix: [fail, fail] } })); // two failed fixes -> escalate
      const { deps, times } = timed(w);
      const start = Date.now();

      await driveWith(deps);

      expect(w.calls).toEqual(["fix:review:38", "fix:review:38", "escalate:38"]);
      expect(times).toHaveLength(1);
      expect(times[0] - start).toBeLessThan(120_000); // a bounded delay only, not an extra escalation backoff
    });
  });

  it("never runs more steps at once than its slot limit", async () => {
    const w = new World();
    for (const n of [1, 2, 3, 4]) w.add(pr(n));

    await drive(w, { max: 1 });
    expect(w.peak).toBe(1);

    const w2 = new World();
    for (const n of [1, 2, 3, 4]) w2.add(pr(n));
    await drive(w2, { max: 3 });
    expect(w2.peak).toBeGreaterThan(1);
    expect(w2.peak).toBeLessThanOrEqual(3);
  });

  it("finishes work before starting new work: merge, then review, then implement", async () => {
    const w = new World();
    w.add(pr(1, { approved: true }));
    w.add(pr(2));
    w.todo.push({ issue: 3, agent: "claude", pr: { author: "claude" } });

    await drive(w, { max: 1 });

    expect(w.calls.slice(0, 3)).toEqual(["merge:1", "review:2", "merge:2"]);
    expect(w.calls.indexOf("implement:claude:3")).toBeGreaterThan(w.calls.indexOf("merge:2"));
  });

  it("does not hot-loop a harness whose claim throws", async () => {
    const w = new World();
    w.implementThrows = true;
    w.todo.push({ issue: 9, agent: "claude", pr: {} });

    const summary = await drive(w);

    expect(summary).toMatchObject({ submitted: [], stopped: "drained" });
    expect(w.said.some((l) => l.includes("could not claim work: claim exploded"))).toBe(true);
  });

  it("treats an executor that throws as a failed step", async () => {
    const w = new World();
    w.add(pr(38, { approved: true }));
    const deps = w.deps();
    let first = true;
    deps.execute = async (obs, step) => {
      if (first) { first = false; throw new Error("boom"); }
      return w.execute(obs, step);
    };
    let done = false;
    const run = runAutopilot(OPTS, deps).finally(() => { done = true; });
    for (let i = 0; i < 500 && !done; i += 1) await vi.advanceTimersByTimeAsync(1000);

    expect(await run).toMatchObject({ merged: [38], failures: 1 });
  });

  describe("aborting while a read is still pending", () => {
    const deferred = () => {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => { release = resolve; });
      return { promise, release };
    };
    const tick = async (n: number) => { for (let i = 0; i < n; i += 1) await vi.advanceTimersByTimeAsync(1000); };

    it("dispatches nothing when Ctrl-C arrives during the board observation", async () => {
      const w = new World();
      w.add(pr(38, { approved: true })); // the observation will say: merge it
      w.todo.push({ issue: 9, agent: "claude", pr: {} }); // ...and there is routed work to start
      const gate = deferred();
      const deps = w.deps();
      const inner = deps.observe;
      let reading = false;
      deps.observe = async () => { const seen = await inner(); reading = true; await gate.promise; return seen; };
      const ctl = new AbortController();

      const run = runAutopilot({ ...OPTS, signal: ctl.signal }, deps);
      for (let i = 0; i < 10 && !reading; i += 1) await tick(1);
      expect(reading).toBe(true); // the read has happened but not returned
      ctl.abort(); // Ctrl-C while observe() is pending
      gate.release(); // ...which then resolves with work to dispatch

      const summary = await run;

      expect(summary.stopped).toBe("aborted");
      expect(w.calls).toEqual([]); // neither a step nor an implementation was started
      expect(w.todo).toHaveLength(1);
      expect(summary.merged).toEqual([]);
    });

    it("dispatches nothing when Ctrl-C arrives during the paused-backlog lookup", async () => {
      const w = new World();
      w.todo.push({ issue: 9, agent: "codex", pr: {} }); // codex is available and would be started
      const gate = deferred();
      const deps = w.deps();
      let looking = false;
      deps.blockedBacklog = async () => { looking = true; await gate.promise; return []; };
      const ctl = new AbortController();

      const run = runAutopilot({ ...OPTS, signal: ctl.signal }, deps);
      for (let i = 0; i < 10 && !looking; i += 1) await tick(1);
      expect(looking).toBe(true);
      ctl.abort();
      gate.release();

      const summary = await run;

      expect(summary.stopped).toBe("aborted");
      expect(w.calls).toEqual([]); // no implement:codex:9
      expect(w.todo).toHaveLength(1);
    });

    it("still waits for work that is already running, and starts nothing after it", async () => {
      const w = new World();
      w.add(pr(38, { changes: true }));
      const fixGate = deferred();
      const obsGate = deferred();
      const deps = w.deps();
      const innerExecute = deps.execute;
      deps.execute = async (obs, step) => {
        if (step.kind === "fix") await fixGate.promise; // a fix is running
        return innerExecute(obs, step);
      };
      const innerObserve = deps.observe;
      let observeCalls = 0;
      deps.observe = async () => {
        const seen = await innerObserve();
        observeCalls += 1;
        if (observeCalls === 2) await obsGate.promise; // the second read is pending while the fix runs
        return seen;
      };
      const ctl = new AbortController();
      let done = false;
      const run = runAutopilot({ ...OPTS, signal: ctl.signal }, deps).finally(() => { done = true; });
      for (let i = 0; i < 10 && observeCalls < 2; i += 1) await tick(1);
      expect(observeCalls).toBe(2);

      ctl.abort();
      obsGate.release();
      await vi.advanceTimersByTimeAsync(50);
      expect(done).toBe(false); // the running fix has not finished, so neither has the loop

      fixGate.release();
      const summary = await run;

      expect(summary.stopped).toBe("aborted");
      expect(w.calls).toEqual(["fix:review:38"]); // the in-flight fix completed; no review or merge was started after it
    });
  });

  it("stops launching when aborted but lets in-flight work finish", async () => {
    const w = new World();
    w.add(pr(38, { approved: true }));
    const ctl = new AbortController();
    ctl.abort();

    const summary = await runAutopilot({ ...OPTS, signal: ctl.signal }, w.deps());

    expect(summary.stopped).toBe("aborted");
    expect(w.calls).toEqual([]);
  });

  it("never starts a new task when told not to claim, but still drives existing PRs", async () => {
    const w = new World();
    w.todo.push({ issue: 7, agent: "claude", pr: {} });
    w.add(pr(38, { approved: true }));

    const summary = await drive(w, { claim: "none" });

    expect(w.calls).toEqual(["merge:38"]);
    expect(w.calls.some((c) => c.startsWith("implement"))).toBe(false);
    expect(w.todo).toHaveLength(1);
    expect(summary).toMatchObject({ merged: [38], submitted: [], stopped: "drained" });
  });

  it("claims by default (the routed filter lives in the implement dependency, not the loop)", async () => {
    const w = new World();
    w.todo.push({ issue: 7, agent: "claude", pr: { author: "claude", approved: true } });

    const summary = await drive(w, { claim: "routed" });

    expect(summary.submitted).toEqual([7]);
  });

  it("launches implementation for each available harness when there is no PR backlog", async () => {
    const w = new World();
    w.todo.push({ issue: 1, agent: "claude", pr: { author: "claude", approved: true } });
    w.todo.push({ issue: 2, agent: "codex", pr: { approved: true } });

    const summary = await drive(w, { max: 2 });

    expect(summary.submitted.sort()).toEqual([1, 2]);
    expect(summary.merged.sort()).toEqual([1, 2]);
  });
});

describe("runAutopilot scoped to one plan", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  /** Scope the fake world the way `defaultDeps(cfg, cwd, scope)` scopes the real one. */
  function scoped(w: World, scope: Set<number>, remaining?: () => Promise<number[]>): CoordinatorDeps {
    const base = w.deps();
    return {
      ...base,
      implement: async (agent, onClaimed) => {
        const before = w.todo;
        w.todo = before.filter((t) => scope.has(t.issue));
        try {
          return await w.implement(agent, onClaimed);
        } finally {
          w.todo = [...w.todo, ...before.filter((t) => !scope.has(t.issue))];
        }
      },
      remaining: remaining ?? (async () => [
        ...[...w.prs.values()].filter((p) => scope.has(p.issue) && !p.merged && !p.attention).map((p) => p.issue),
        ...w.todo.filter((t) => scope.has(t.issue)).map((t) => t.issue),
      ]),
    };
  }

  async function driveScoped(w: World, scope: Set<number>, remaining?: () => Promise<number[]>) {
    let done = false;
    const run = runAutopilot({ ...OPTS, issues: scope }, scoped(w, scope, remaining)).finally(() => { done = true; });
    for (let i = 0; i < 2000 && !done; i += 1) await vi.advanceTimersByTimeAsync(1000);
    expect(done, "the loop must terminate").toBe(true);
    return run;
  }

  it("drives and claims only the plan's issues and reports the plan complete", async () => {
    const w = new World();
    w.add(pr(5));
    w.add(pr(99, { mergeable: "conflicting" })); // someone else's PR: never touched
    w.todo.push({ issue: 6, agent: "claude", pr: { author: "claude" } });
    w.todo.push({ issue: 98, agent: "codex", pr: {} }); // routed backlog outside the plan: never claimed

    const summary = await driveScoped(w, new Set([5, 6]));

    expect(w.calls.filter((c) => c.endsWith(":99") || c.endsWith(":98"))).toEqual([]);
    expect(summary.merged.sort()).toEqual([5, 6]);
    expect(summary).toMatchObject({ stopped: "plan-complete", remaining: [] });
    expect(w.todo.map((t) => t.issue)).toEqual([98]);
  });

  it("counts an escalated issue as handed off, so the plan still completes", async () => {
    const w = new World();
    w.maxRounds = 1;
    w.add(pr(5, { verdicts: ["changes", "changes"] }));
    w.add(pr(6));

    const summary = await driveScoped(w, new Set([5, 6]));

    expect(summary).toMatchObject({ merged: [6], escalated: [5], stopped: "plan-complete", remaining: [] });
  });

  it("reports drained with the issues still open when the plan cannot finish", async () => {
    const w = new World();
    w.add(pr(5));

    const summary = await driveScoped(w, new Set([5, 7]), async () => [7]);

    expect(summary).toMatchObject({ merged: [5], stopped: "drained", remaining: [7] });
    expect(w.said.some((line) => line.includes("#7 still open"))).toBe(true);
  });

  it("never claims completion it could not check", async () => {
    const w = new World();
    w.add(pr(5));

    const summary = await driveScoped(w, new Set([5]), async () => { throw new Error("gh down"); });

    expect(summary).toMatchObject({ merged: [5], stopped: "drained", remaining: null });
  });
});

describe("runAutopilot with lead triage", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("lets the lead grant one more round when the budget is spent, then merges", async () => {
    const w = new World();
    w.maxRounds = 1;
    w.maxTriages = 1;
    w.add(pr(38, { verdicts: ["changes", "changes", "approve"] }));

    const summary = await drive(w);

    expect(w.calls).toEqual(["review:38", "fix:review:38", "review:38", "triage:38", "fix:review:38", "review:38", "merge:38"]);
    expect(summary).toMatchObject({ merged: [38], triaged: [38], escalated: [] });
  });

  it("escalates once the granted round is spent too, never triaging the same task twice", async () => {
    const w = new World();
    w.maxRounds = 1;
    w.maxTriages = 1;
    w.add(pr(38, { verdicts: ["changes", "changes", "changes"] }));

    const summary = await drive(w);

    expect(w.calls.filter((c) => c === "triage:38")).toHaveLength(1);
    expect(w.calls.at(-1)).toBe("escalate:38");
    expect(summary).toMatchObject({ merged: [], triaged: [38], escalated: [38] });
  });

  it("hands the task to a human when the lead says so", async () => {
    const w = new World();
    w.maxRounds = 1;
    w.maxTriages = 1;
    w.triageDecision = "escalate";
    w.add(pr(38, { verdicts: ["changes", "changes"] }));

    const summary = await drive(w);

    expect(w.calls).toEqual(["review:38", "fix:review:38", "review:38", "triage:38"]);
    expect(summary).toMatchObject({ triaged: [], escalated: [38] });
  });

  it("escalates a triage that keeps failing instead of retrying it forever", async () => {
    const w = new World();
    w.maxRounds = 1;
    w.maxTriages = 1;
    w.add(pr(38, {
      verdicts: ["changes", "changes"],
      overrides: { triage: [{ signal: "step.failed", detail: "gh down" }, { signal: "step.failed", detail: "gh down" }] },
    }));

    const summary = await drive(w);

    expect(w.calls.filter((c) => c === "triage:38")).toHaveLength(MAX_STEP_FAILURES);
    expect(w.calls.at(-1)).toBe("escalate:38");
    expect(summary.escalated).toEqual([38]);
  });
});
