import { describe, expect, it, vi } from "vitest";
import { AUTOPILOT_SCENARIOS } from "../src/demo/scenarios/autopilot.js";
import { checkFrame, checkScenario, ScenarioDriftError } from "../src/demo/scenario-engine.js";
import { STEP_NODES } from "../src/demo/flow-graph.js";
import { decideStep, type Step, type StepFacts } from "../src/tasks/steps.js";
import { parseTriageDecision, triageFacts } from "../src/tasks/triage.js";
import { evaluateGate } from "../src/board/review.js";

const byId = (id: string) => AUTOPILOT_SCENARIOS.find((s) => s.id === `autopilot-${id}`)!;
const decisions = (id: string, fn: string) => byId(id).frames.flatMap((f) => f.decision?.fn === fn ? [f.decision] : []);

const terminals: Record<string, string> = {
  "review-fix": "state.done", "ci-fix": "state.done", conflict: "state.done",
  "wait-ci": "state.done", "wait-mergeability": "state.done", "await-human": "step.await-human",
  "triage-retry": "state.done", "triage-escalate": "step.none", "triage-disabled": "step.none", ambiguous: "auto.observe",
};

describe("autopilot scenarios", () => {
  it.each(Object.entries(terminals))("%s passes drift checks and reaches %s", (id, terminal) => {
    const scenario = byId(id);
    expect(() => checkScenario(scenario)).not.toThrow();
    expect(scenario.frames.at(-1)!.activeNode).toBe(terminal);
    if (terminal === "state.done") expect(scenario.frames.at(-1)!.board).toEqual([]);
  });

  it("calls production deciders with replayable facts and covers every Step.kind", () => {
    const kinds = new Set<Step["kind"]>();
    for (const s of AUTOPILOT_SCENARIOS) for (const f of s.frames) {
      const d = f.decision;
      if (!d) continue;
      if (d.fn === "decideStep") {
        expect(d.output).toEqual(decideStep(d.input as StepFacts));
        kinds.add((d.output as Step).kind);
      } else if (d.fn === "parseTriageDecision") {
        expect(d.output).toEqual(parseTriageDecision(d.input as string));
      } else if (d.fn === "triageFacts") {
        const i = d.input as { comments: { id: number; body: string }[]; pr: number; maxTriages: number };
        expect(d.output).toEqual(triageFacts(i.comments, i.pr, i.maxTriages));
      } else if (d.fn === "evaluateGate") {
        expect(d.output).toEqual(evaluateGate(d.input as Parameters<typeof evaluateGate>[0]));
      }
    }
    expect([...kinds].sort()).toEqual(Object.keys(STEP_NODES).sort());
  });

  it("requests changes, resumes a fix, reviews the new head, then gates the merge", () => {
    expect(decisions("review-fix", "decideStep").map((d) => d.output)).toEqual([
      { kind: "review" }, { kind: "fix", reason: "review" }, { kind: "review" }, { kind: "merge" },
    ]);
    const steps = decisions("review-fix", "decideStep");
    expect((steps[2]!.input as StepFacts).pr!.head).not.toBe((steps[0]!.input as StepFacts).pr!.head);
    expect(byId("review-fix").frames.find((f) => f.activeNode === "auto.push")!.narration).toContain("Resume the author's saved session");
    expect(decisions("review-fix", "evaluateGate").at(-1)!.output).toEqual([]);
  });

  it("distinguishes CI fixes, conflict merges, pending CI and unknown mergeability", () => {
    expect(decisions("ci-fix", "decideStep")[0]!.output).toEqual({ kind: "fix", reason: "ci" });
    expect(decisions("conflict", "decideStep")[0]!.output).toEqual({ kind: "resolve-conflict" });
    expect(byId("conflict").frames.find((f) => f.activeNode === "auto.push")!.narration).toContain("never rebase");
    expect(decisions("wait-ci", "decideStep")[0]!.output).toEqual({ kind: "wait", reason: "CI is still running" });
    expect(decisions("wait-mergeability", "decideStep")[0]!.output).toEqual({ kind: "wait", reason: "GitHub is still computing mergeability" });
    expect((decisions("await-human", "decideStep")[0]!.input as StepFacts).requireHumanMerge).toBe(true);
  });

  it("recovers a hard retry's round and guidance from its durable comment", () => {
    expect(decisions("triage-retry", "parseTriageDecision")[0]!.output).toMatchObject({ decision: "retry", effort: "hard" });
    const recovered = decisions("triage-retry", "triageFacts")[0]!;
    expect(recovered.output).toMatchObject({ triages: 1, extraRounds: 1, guidance: expect.stringContaining("regression test") });
    expect(decisions("triage-retry", "decideStep").map((d) => (d.output as Step).kind)).toEqual(["triage", "fix", "review", "merge"]);
    expect(decisions("triage-retry", "decideStep")[1]!.input).toMatchObject({ rounds: 3, maxRounds: 3, triages: 1, extraRounds: 1 });
  });

  it.each(["triage-escalate", "triage-disabled"])("%s hands off with attention and a comment", (id) => {
    const s = byId(id);
    const handoff = s.frames.find((f) => f.activeNode === "auto.handoff")!;
    expect(handoff.board[0]!.status).toBe("needs-attention");
    expect(handoff.narration).toContain("PR comment");
    expect(s.frames.at(-1)!.decision!.input).toMatchObject({ attention: true });
    if (id === "triage-disabled") {
      expect(decisions(id, "decideStep")[0]!.input).toMatchObject({ maxTriages: 0 });
      expect(decisions(id, "parseTriageDecision")).toEqual([]);
    } else expect(decisions(id, "parseTriageDecision")[0]!.output).toMatchObject({ decision: "escalate", diagnosis: expect.any(String) });
  });

  it("rejects drift in step kinds, fix reasons, triage verdicts and recovered retry facts", () => {
    const corrupt = (id: string, fn: string, output: unknown) => {
      const f = byId(id).frames.find((f) => f.decision?.fn === fn)!;
      expect(() => checkFrame({ ...f, decision: { ...f.decision!, output } })).toThrow(ScenarioDriftError);
    };
    corrupt("ci-fix", "decideStep", { kind: "fix", reason: "review" });
    corrupt("conflict", "decideStep", { kind: "merge" });
    corrupt("triage-retry", "parseTriageDecision", { decision: "escalate", diagnosis: "No retry" });
    corrupt("triage-escalate", "parseTriageDecision", { decision: "retry", guidance: "Try again" });
    corrupt("triage-retry", "triageFacts", { triages: 0, extraRounds: 0, guidance: null });
  });

  it("reports twin PRs without driving either, matching production observation", async () => {
    vi.doMock("../src/github/github.js", () => ({
      listIssues: async () => [{ number: 93, title: "Twin PRs", body: "", state: "OPEN", labels: ["agent:codex"], assignees: [] }],
      listOpenPrs: async () => [193, 194].map((number) => ({ number, title: "Twin", body: "Closes #93", state: "OPEN", headRefName: "task/93-twins", headSha: "a".repeat(40), htmlUrl: "" })),
      listPrReviews: vi.fn(() => { throw new Error("Twins must be filtered before per-PR reads"); }),
      prChecksState: vi.fn(), prMergeability: vi.fn(), listPrComments: vi.fn(),
    }));
    vi.doMock("../src/tasks/events.js", () => ({ readEvents: () => [], fixRoundsFor: () => 0 }));
    try {
      const { observeTasks } = await import("../src/tasks/observe.js");
      const { DEFAULT_CONFIG } = await import("../src/config.js");
      const observation = await observeTasks(DEFAULT_CONFIG, ".");
      expect(observation).toEqual({ tasks: [], unobserved: [], ambiguous: [{ issue: 93, prs: [193, 194] }] });
      const s = byId("ambiguous");
      expect(s.frames).toHaveLength(1);
      expect(s.frames[0]!.narration).toContain("#193 and #194");
      expect(s.frames[0]!.decision).toBeUndefined();
      expect(s.frames[0]!.board[0]!.prNumber).toBeNull();
    } finally {
      vi.doUnmock("../src/github/github.js");
      vi.doUnmock("../src/tasks/events.js");
    }
  });
});
