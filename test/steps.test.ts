import { describe, expect, it } from "vitest";
import { reviewSatisfied } from "../src/board/review.js";
import { decideStep, type StepFacts } from "../src/tasks/steps.js";

function facts(over: {
  attention?: boolean;
  pr?: Partial<NonNullable<StepFacts["pr"]>> | null;
  review?: Partial<StepFacts["review"]>;
  rounds?: number;
  maxRounds?: number;
  requireHumanMerge?: boolean;
} = {}): StepFacts {
  return {
    attention: over.attention ?? false,
    pr: over.pr === null ? null : { number: 9, head: "a".repeat(40), checks: "pass", mergeable: "clean", ...over.pr },
    review: { approved: false, changesRequested: false, ...over.review },
    rounds: over.rounds ?? 0,
    maxRounds: over.maxRounds ?? 3,
    requireHumanMerge: over.requireHumanMerge ?? false,
  };
}

describe("decideStep", () => {
  it("leaves a task alone when a human owns it or there is no PR yet", () => {
    expect(decideStep(facts({ attention: true, review: { changesRequested: true } })).kind).toBe("none");
    expect(decideStep(facts({ pr: null })).kind).toBe("none");
  });

  it("asks for a review when the head has no decision yet", () => {
    expect(decideStep(facts())).toEqual({ kind: "review" });
  });

  it("reviews while CI is still running instead of waiting on it", () => {
    expect(decideStep(facts({ pr: { checks: "pending" } }))).toEqual({ kind: "review" });
  });

  it("sends review feedback back to the author", () => {
    expect(decideStep(facts({ review: { changesRequested: true } }))).toEqual({ kind: "fix", reason: "review" });
  });

  it("sends a red CI back to the author, even when approved", () => {
    expect(decideStep(facts({ pr: { checks: "fail" }, review: { approved: true } }))).toEqual({ kind: "fix", reason: "ci" });
  });

  it("addresses review feedback before a red CI", () => {
    const step = decideStep(facts({ pr: { checks: "fail" }, review: { changesRequested: true } }));
    expect(step).toEqual({ kind: "fix", reason: "review" });
  });

  it("resolves a conflict before reviewing a head that is about to change", () => {
    expect(decideStep(facts({ pr: { mergeable: "conflicting" } }))).toEqual({ kind: "resolve-conflict" });
    expect(decideStep(facts({ pr: { mergeable: "conflicting" }, review: { approved: true } }))).toEqual({ kind: "resolve-conflict" });
  });

  it("merges an approved, green, clean PR", () => {
    expect(decideStep(facts({ review: { approved: true } }))).toEqual({ kind: "merge" });
    expect(decideStep(facts({ review: { approved: true }, pr: { checks: "none" } }))).toEqual({ kind: "merge" });
  });

  it("waits for CI or mergeability to settle once approved", () => {
    expect(decideStep(facts({ review: { approved: true }, pr: { checks: "pending" } })).kind).toBe("wait");
    expect(decideStep(facts({ review: { approved: true }, pr: { mergeable: "unknown" } })).kind).toBe("wait");
  });

  it("stops at approval when a human must merge", () => {
    expect(decideStep(facts({ review: { approved: true }, requireHumanMerge: true })).kind).toBe("await-human");
  });

  it("does not hold back a fix or review because of requireHumanMerge", () => {
    expect(decideStep(facts({ requireHumanMerge: true }))).toEqual({ kind: "review" });
    expect(decideStep(facts({ requireHumanMerge: true, review: { changesRequested: true } })).kind).toBe("fix");
  });

  describe("round budget", () => {
    it("escalates instead of fixing once the budget is spent", () => {
      for (const over of [
        { review: { changesRequested: true } },
        { pr: { checks: "fail" as const } },
        { pr: { mergeable: "conflicting" as const } },
      ]) {
        const step = decideStep(facts({ ...over, rounds: 3, maxRounds: 3 }));
        expect(step.kind).toBe("escalate");
      }
    });

    it("still fixes while rounds remain", () => {
      expect(decideStep(facts({ review: { changesRequested: true }, rounds: 2, maxRounds: 3 })).kind).toBe("fix");
    });

    it("explains what ran out and by how much", () => {
      const step = decideStep(facts({ pr: { checks: "fail" }, rounds: 1, maxRounds: 1 }));
      expect(step).toMatchObject({ kind: "escalate", reason: expect.stringContaining("CI is still failing after 1 fix round (limit 1)") });
    });

    it("never escalates a task that is merely approved and waiting", () => {
      expect(decideStep(facts({ review: { approved: true }, rounds: 99 })).kind).toBe("merge");
    });
  });
});

describe("reviewSatisfied", () => {
  const base = { agents: ["claude", "codex"], reviewPolicy: "cross-or-self" as const };

  it("accepts the other harness and rejects no or author-only approval", () => {
    expect(reviewSatisfied({ ...base, author: "claude", reviewers: ["codex"] })).toBe(true);
    expect(reviewSatisfied({ ...base, author: "claude", reviewers: [] })).toBe(false);
    expect(reviewSatisfied({ ...base, author: "claude", reviewers: ["claude"] })).toBe(false);
  });

  it("accepts a marked self-review only under cross-or-self", () => {
    const self = { ...base, author: "claude", reviewers: ["claude"], selfReviewers: ["claude"] };
    expect(reviewSatisfied(self)).toBe(true);
    expect(reviewSatisfied({ ...self, reviewPolicy: "cross" })).toBe(false);
  });

  it("ignores reviewers that are not configured agents", () => {
    expect(reviewSatisfied({ ...base, author: "claude", reviewers: ["ghost"] })).toBe(false);
  });
});

describe("decideStep: lead triage before human escalation", () => {
  const spent = (over: Partial<StepFacts> = {}): StepFacts => ({
    ...facts({ review: { changesRequested: true }, rounds: 3, maxRounds: 3 }),
    ...over,
  });

  it("asks the lead to triage instead of escalating while its triage budget lasts", () => {
    expect(decideStep(spent({ triages: 0, maxTriages: 1 }))).toEqual({
      kind: "triage",
      reason: "review feedback is still unresolved after 3 fix rounds (limit 3)",
    });
    expect(decideStep({ ...spent({ triages: 0, maxTriages: 1 }), review: { approved: false, changesRequested: false }, pr: { number: 9, head: "a".repeat(40), checks: "fail", mergeable: "clean" } }).kind)
      .toBe("triage");
    expect(decideStep({ ...spent({ triages: 0, maxTriages: 1 }), review: { approved: false, changesRequested: false }, pr: { number: 9, head: "a".repeat(40), checks: "pass", mergeable: "conflicting" } }).kind)
      .toBe("triage");
  });

  it("escalates once the triage budget is spent, or when triage is disabled or unset", () => {
    expect(decideStep(spent({ triages: 1, maxTriages: 1, extraRounds: 1, rounds: 4 }))).toEqual({
      kind: "escalate",
      reason: "review feedback is still unresolved after 4 fix rounds (limit 3 + 1 granted by triage)",
    });
    expect(decideStep(spent({ triages: 0, maxTriages: 0 })).kind).toBe("escalate");
    expect(decideStep(spent()).kind).toBe("escalate"); // facts without triage fields behave as before
  });

  it("lets rounds granted by a triage extend the budget: the next fix runs", () => {
    expect(decideStep(spent({ triages: 1, maxTriages: 1, extraRounds: 1 }))).toEqual({ kind: "fix", reason: "review" });
  });

  it("never triages a task that is not stuck", () => {
    expect(decideStep(facts({ review: { changesRequested: true }, rounds: 2, maxRounds: 3 })).kind).toBe("fix");
    expect(decideStep({ ...facts({ review: { approved: true }, rounds: 5 }), triages: 0, maxTriages: 1 }).kind).toBe("merge");
  });
});
