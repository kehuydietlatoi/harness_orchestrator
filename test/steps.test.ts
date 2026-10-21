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
  it("keeps every ordinary PR combination unchanged when observe is not required", () => {
    for (const checks of ["pass", "fail", "pending", "none"] as const)
      for (const mergeable of ["clean", "conflicting", "unknown"] as const)
        for (const approved of [false, true]) for (const changesRequested of [false, true])
          for (const rounds of [0, 3]) for (const attention of [false, true]) {
            const f = facts({ pr: { checks, mergeable }, review: { approved, changesRequested }, rounds, attention });
            expect(decideStep({ ...f, observe: { required: false, state: "missing" } })).toEqual(decideStep(f));
          }
  });
  it("observes before review and uses the review round budget", () => {
    const f = (state: NonNullable<StepFacts["observe"]>["state"]): StepFacts => ({ ...facts(), observe: { required: true, state } });
    expect(decideStep(f("missing"))).toEqual({ kind: "observe" });
    expect(decideStep(f("verified"))).toEqual({ kind: "review" });
    expect(decideStep(f("not-verified"))).toEqual({ kind: "fix", reason: "observe" });
    expect(decideStep({ ...f("blocked"), observeReason: "capture failed" })).toEqual({ kind: "escalate", reason: "capture failed" });
    expect(decideStep({ ...f("not-verified"), rounds: 3 }).kind).toBe("escalate");
    expect(decideStep({ ...f("not-verified"), rounds: 3, maxTriages: 1 }).kind).toBe("triage");
    expect(decideStep({ ...f("missing"), pr: { ...facts().pr!, checks: "pending" } }).kind).toBe("observe");
    for (const state of ["missing", "verified", "not-verified", "blocked"] as const) {
      expect(decideStep({ ...f(state), attention: true }).kind).toBe("none");
      expect(decideStep({ ...f(state), review: { approved: false, changesRequested: true } })).toEqual({ kind: "fix", reason: "review" });
      expect(decideStep({ ...f(state), pr: { ...facts().pr!, checks: "fail" } })).toEqual({ kind: "fix", reason: "ci" });
      expect(decideStep({ ...f(state), pr: { ...facts().pr!, mergeable: "conflicting" } }).kind).toBe("resolve-conflict");
    }
  });
  it("escalates scope violations ahead of review, fixes, triage or merging", () => {
    for (const over of [{}, { review: { changesRequested: true } }, { review: { approved: true } }, { pr: { checks: "fail" as const } }]) {
      expect(decideStep({ ...facts(over), scopeFailure: "design/a.md: forbidden by design/**", maxTriages: 10 }))
        .toEqual({ kind: "escalate", reason: "design/a.md: forbidden by design/**" });
    }
  });
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

describe("fix cascade", () => {
  const route = { agent: "claude", tier: "lead" } as const;
  it.each([undefined, route])("re-observes a disputed verdict once, then quotes the notes for a human: %j", (nextCascade) => {
    const f: StepFacts = {
      ...facts(), nextCascade, failedFixAttempts: 1,
      observe: { required: true, state: "not-verified" },
      observeReason: "The screenshot shows the old page",
      observeNotVerifiedCount: 1,
    };
    expect(decideStep(f)).toEqual({ kind: "observe" });
    expect(decideStep({ ...f, rounds: 3, maxTriages: 1 })).toEqual({ kind: "observe" });
    expect(decideStep({ ...f, observeNotVerifiedCount: 2 })).toEqual({
      kind: "escalate", reason: 'The author disputes the observe verdict after a fix made no commit; observe was not-verified twice on this head. Verdict notes: "The screenshot shows the old page"',
    });
    expect(decideStep({ ...f, failedFixAttempts: 0 })).toEqual({ kind: "fix", reason: "observe" });
  });
  const gates: Partial<StepFacts>[] = [
    { review: { approved: false, changesRequested: true } },
    { pr: { number: 9, head: "h", checks: "pass", mergeable: "conflicting" } },
  ];
  it.each([undefined, route])("escalates a failed CI fix without cascading or spending triage: %j", (nextCascade) => {
    expect(decideStep({
      ...facts({ pr: { checks: "fail" } }), failedFixAttempts: 1, nextCascade, maxTriages: 1,
    })).toMatchObject({ kind: "escalate", reason: expect.stringContaining("CI") });
  });
  it.each(gates)("cascades a failed fix-type attempt before budget triage: %j", (gate) => {
    const f = { ...facts(), ...gate, nextCascade: route };
    expect(decideStep(f).kind).not.toBe("cascade");
    expect(decideStep({ ...f, failedFixAttempts: 1 })).toEqual({ kind: "cascade", route });
    expect(decideStep({ ...f, failedFixAttempts: 1, rounds: 3, maxTriages: 1 }).kind).toBe("cascade");
  });
  it("preserves retry, triage and escalation without a member", () => {
    const f = { ...facts({ review: { changesRequested: true } }), failedFixAttempts: 1 };
    expect(decideStep(f)).toEqual({ kind: "fix", reason: "review" });
    expect(decideStep({ ...f, rounds: 3, maxTriages: 1 }).kind).toBe("triage");
    expect(decideStep({ ...f, rounds: 3 }).kind).toBe("escalate");
  });
  it("never cascades reviews, waiting, merging or human-owned tasks", () => {
    for (const f of [facts(), facts({ review: { approved: true } }), facts({ attention: true }), facts({ pr: null })]) {
      expect(decideStep({ ...f, failedFixAttempts: 1, nextCascade: route }).kind).not.toBe("cascade");
    }
  });
});
