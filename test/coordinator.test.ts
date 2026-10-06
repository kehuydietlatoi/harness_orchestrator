import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_STEP_FAILURES, runAutopilot, type ActionableStep, type AutopilotOptions, type CoordinatorDeps,
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
  /** Verdicts the reviewer will return in order; "approve" once exhausted. */
  verdicts: Array<"approve" | "changes">;
  /** Scripted results that override the normal outcome of the next executions of a step kind. */
  overrides: Partial<Record<ActionableStep["kind"], StepResult[]>>;
}

function pr(issue: number, over: Partial<SimPr> = {}): SimPr {
  return {
    issue, author: "codex", version: 1, checks: "pass", mergeable: "clean", approved: false, changes: false,
    rounds: 0, attention: false, merged: false, verdicts: [], overrides: {}, ...over,
  };
}

class World {
  prs = new Map<number, SimPr>();
  todo: Array<{ issue: number; agent: string; pr: Partial<SimPr> }> = [];
  calls: string[] = [];
  events: Array<Omit<OrchEvent, "ts">> = [];
  said: string[] = [];
  active = 0;
  peak = 0;
  maxRounds = 3;
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
      return { tasks: [], unobserved: open.map((p) => 1000 + p.issue) };
    }
    const tasks = open.map((p) => {
      const facts = {
        attention: p.attention,
        pr: { number: 1000 + p.issue, head: `h${p.version}`, checks: p.checks, mergeable: p.mergeable },
        review: { approved: p.approved, changesRequested: p.changes },
        rounds: p.rounds, maxRounds: this.maxRounds, requireHumanMerge: this.requireHumanMerge,
      };
      return {
        issue: { number: p.issue, title: `t${p.issue}`, body: "", state: "OPEN", labels: [], assignees: [] },
        author: p.author,
        pr: { number: 1000 + p.issue, title: "", body: "", state: "OPEN", headSha: `h${p.version}`, headRefName: `task/${p.issue}-x`, htmlUrl: "" },
        reviews: [], facts, step: decideStep(facts), feedback: p.changes ? "please fix" : null,
      } as TaskObservation;
    });
    return { tasks, unobserved: [] };
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
