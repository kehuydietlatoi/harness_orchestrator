import { describe, expect, it, vi } from "vitest";
import { makeDemoDeps } from "../src/server/demo.js";
import { applyPlan, selectUnassigned } from "../src/routing/assign.js";
import { SCENARIOS } from "../src/demo/scenarios/index.js";

const CWD = process.cwd();

describe("demo backend", () => {
  it("plays frame boards forward and backward, then resets to a fresh seeded board", async () => {
    const deps = makeDemoDeps();
    const demo = deps.demo!;
    const seeded = await deps.snapshot(CWD);
    expect(demo.current()).toEqual({ scenarioId: null, index: 0, total: 0, frame: null });
    expect(demo.list().map((s) => s.id)).toEqual(SCENARIOS.map((s) => s.id));
    expect(() => demo.step("next")).toThrow(/no scenario/);
    for (const scenario of SCENARIOS) {
      expect(demo.load(scenario.id).frame).toEqual(scenario.frames[0]);
      expect(demo.step("prev").index).toBe(0);
      for (let i = 0; i < scenario.frames.length; i++) {
        const current = demo.current();
        expect(current).toMatchObject({ scenarioId: scenario.id, index: i, total: scenario.frames.length,
          frame: scenario.frames[i] });
        const snapshot = await deps.snapshot(CWD);
        expect(Object.keys(snapshot).sort()).toEqual(Object.keys(seeded).sort());
        expect(snapshot.tasks.map((t) => t.number)).toEqual(scenario.frames[i].board.map((t) => t.number));
        for (const task of scenario.frames[i].board) {
          expect(snapshot.tasks.find((t) => t.number === task.number)).toMatchObject({
            title: task.title, agent: task.agent, status: task.status, deps: task.deps,
            after: task.after, prNumber: task.prNumber, locked: task.locked, worktree: task.worktree,
            reviewedBy: task.reviewedBy, prChecks: task.prChecks, latestRun: task.latestRun,
          });
        }
        demo.step("next");
      }
      expect(demo.current().index).toBe(scenario.frames.length - 1);
      if (scenario.frames.length > 1) {
        expect(demo.step("prev").frame).toEqual(scenario.frames[scenario.frames.length - 2]);
      }
    }
    const before = demo.current();
    expect(() => demo.load("missing")).toThrow(/unknown scenario/);
    expect(demo.current()).toEqual(before);
    await deps.editIssue(107, ["agent:codex"], CWD);
    expect(demo.reset().frame).toBeNull();
    expect((await deps.snapshot(CWD)).tasks.map(({ latestRun: _latestRun, ...task }) => task))
      .toEqual(seeded.tasks.map(({ latestRun: _latestRun, ...task }) => task));
  });

  it("preserves advisory plan references on retry and dispatches while the predecessor is claimed", async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDemoDeps();
      const tickets = [{ id: "a", title: "A" }, { id: "b", title: "B", after: ["a"] },
        { title: "C", dependsOn: ["a"] }];
      const first = await deps.createIssues(tickets, CWD);
      const [a, b, c] = first.created.map((t) => t.number);
      expect(await deps.createIssues(tickets, CWD)).toMatchObject({ created: [], failed: [], reused: first.created });
      for (const n of [a, b, c]) await deps.editIssue(n, ["agent:codex"], CWD);
      await deps.dispatchIssue(a, CWD);
      const snap = await deps.snapshot(CWD);
      expect(snap.tasks.find((t) => t.number === b)).toMatchObject({ after: [a], blockers: [] });
      expect((await deps.listOpenIssues(CWD)).find((i) => i.number === b)?.body).toContain(`After: #${a}`);
      await expect(deps.dispatchIssue(b, CWD)).resolves.toBeUndefined();
      await expect(deps.dispatchIssue(c, CWD)).rejects.toThrow(/blocked by/);
      await expect(deps.dispatchIssue(b, CWD)).rejects.toThrow(/not a todo/);
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });
  it("serves a seeded board with work in flight and a review queue", async () => {
    const deps = makeDemoDeps();
    const snap = await deps.snapshot(CWD);

    expect(snap.tasks.length).toBeGreaterThan(0);
    expect(snap.reviewQueue).toEqual([203, 204]);
    expect(snap.tasks.some((t) => t.agent === "claude")).toBe(true);
    expect(snap.tasks.some((t) => t.agent === "codex")).toBe(true);
  });

  it("suggests exactly the unassigned issues, each with a rationale", async () => {
    const deps = makeDemoDeps();
    const issues = await deps.listOpenIssues(CWD);
    const unassigned = selectUnassigned(issues).map((i) => i.number);

    const suggestions = await deps.runJudge("", deps.loadConfig(CWD), CWD);
    expect(suggestions.map((s) => s.issue).sort()).toEqual([...unassigned].sort());
    expect(suggestions.every((s) => (s.rationale ?? "").length > 0)).toBe(true);
    expect(suggestions.every((s) => deps.loadConfig(CWD).agents.includes(s.agent))).toBe(true);
  });

  it("Apply mutates the board so re-suggesting shrinks the candidate set", async () => {
    const deps = makeDemoDeps();
    const cfg = deps.loadConfig(CWD);

    const before = await deps.runJudge("", cfg, CWD);
    expect(before.length).toBeGreaterThan(0);

    // Apply the plan through the real writer, then persist via the (faked) editIssue.
    const { writes } = applyPlan(before, await deps.listOpenIssues(CWD), cfg);
    expect(writes.length).toBe(before.length);
    for (const w of writes) await deps.editIssue(w.issue, [`agent:${w.agent}`, `effort:${w.effort}`], CWD);

    const after = await deps.runJudge("", cfg, CWD);
    expect(after.length).toBe(0);

    const snap = await deps.snapshot(CWD);
    for (const w of writes) {
      expect(snap.tasks.find((t) => t.number === w.issue)?.agent).toBe(w.agent);
    }
  });

  it("simulates dispatch from claimed through in-progress to in-review", async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDemoDeps({ lifecycleStepMs: 100 });
      await deps.editIssue(107, ["agent:claude", "effort:hard"], CWD);

      await deps.dispatchIssue(107, CWD);
      expect((await deps.snapshot(CWD)).tasks.find((t) => t.number === 107)).toMatchObject({
        status: "status:claimed",
        locked: true,
        worktree: "../wt/issue-107",
      });

      await vi.advanceTimersByTimeAsync(100);
      expect((await deps.snapshot(CWD)).tasks.find((t) => t.number === 107)?.status).toBe("status:in-progress");

      await vi.advanceTimersByTimeAsync(100);
      const finished = await deps.snapshot(CWD);
      expect(finished.tasks.find((t) => t.number === 107)).toMatchObject({
        status: "status:in-review",
        prNumber: 205,
      });
      expect(finished.reviewQueue).toContain(205);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses to simulate dispatch for an unrouted or dependency-blocked todo", async () => {
    const deps = makeDemoDeps();
    await expect(deps.dispatchIssue(107, CWD)).rejects.toThrow(/not routed/);
    await deps.editIssue(108, ["agent:codex", "effort:easy"], CWD);
    await expect(deps.dispatchIssue(108, CWD)).rejects.toThrow(/blocked by.*#103/);
  });
});
