import { describe, expect, it } from "vitest";
import { makeDemoDeps } from "../src/server/demo.js";
import { applyPlan, selectUnassigned } from "../src/routing/assign.js";

const CWD = process.cwd();

describe("demo backend", () => {
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
});
