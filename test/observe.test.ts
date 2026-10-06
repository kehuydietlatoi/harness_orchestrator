import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, type OrchConfig } from "../src/config.js";
import { answeredChangeRequestRounds, formatReview, latestChangeRequestNotes } from "../src/board/approval.js";

vi.mock("../src/github/github.js", () => ({
  listIssues: vi.fn(), listOpenPrs: vi.fn(), listPrReviews: vi.fn(), prChecksState: vi.fn(), prMergeability: vi.fn(),
}));
vi.mock("../src/tasks/events.js", () => ({ readEvents: () => [], fixRoundsFor: () => 0 }));

import * as gh from "../src/github/github.js";
import { assembleFacts, observeTasks } from "../src/tasks/observe.js";

const HEAD = "a".repeat(40);
const OLD = "c".repeat(40);
const pr = { number: 62, title: "t", body: "Closes #38", state: "OPEN", headSha: HEAD, headRefName: "task/38-x", htmlUrl: "" };
const issue = { number: 38, title: "t", body: "", state: "OPEN", labels: ["agent:claude", "status:in-review"], assignees: [] };

let id = 0;
function review(reviewer: string, decision: "approve" | "request-changes", opts: { head?: string; mode?: "self"; note?: string } = {}) {
  const head = opts.head ?? HEAD;
  return {
    id: ++id, state: "COMMENTED", commit_id: head,
    body: formatReview({ reviewer, pr: 62, head, timestamp: "2026-10-06T12:00:00Z", decision, ...(opts.mode ? { mode: opts.mode } : {}) }, opts.note ?? "note"),
  };
}

describe("review history helpers", () => {
  it("counts the distinct earlier heads that drew a change request, and nothing else", () => {
    const reviews = [review("codex", "request-changes", { head: OLD }), review("codex", "approve"), review("codex", "request-changes")];
    expect(answeredChangeRequestRounds(reviews, 62, HEAD)).toBe(1); // OLD was answered; HEAD is still pending
    expect(answeredChangeRequestRounds(reviews, 62, OLD)).toBe(1); // ...from OLD's side, HEAD is the later one
    expect(answeredChangeRequestRounds(reviews, 99, HEAD)).toBe(0);
    expect(answeredChangeRequestRounds([{ id: 1, state: "COMMENTED", commit_id: HEAD, body: "hand-written" }], 62, HEAD)).toBe(0);
  });

  it("counts several requests on one unchanged head once: they ask for a single fix", () => {
    const sameHead = [
      review("codex", "request-changes", { head: OLD }),
      review("claude", "request-changes", { head: OLD }),
      review("codex", "request-changes", { head: OLD }),
    ];
    expect(answeredChangeRequestRounds(sameHead, 62, HEAD)).toBe(1);
    expect(answeredChangeRequestRounds(sameHead, 62, OLD)).toBe(0); // all of it is still pending on OLD
  });

  it("does not count a request on the current head even after an approval on that same head", () => {
    // The reviewer changed their mind without any fix being pushed: no round was spent.
    const reviews = [review("codex", "request-changes"), review("codex", "approve")];
    expect(answeredChangeRequestRounds(reviews, 62, HEAD)).toBe(0);
  });

  it("returns the newest request-changes notes only for the current head", () => {
    const reviews = [review("codex", "request-changes", { note: "first" }), review("codex", "request-changes", { note: "second\nline" })];
    expect(latestChangeRequestNotes(reviews, 62, HEAD)).toBe("second\nline");
    expect(latestChangeRequestNotes(reviews, 62, OLD)).toBeNull();
  });

  it("returns null once a later approval supersedes the request", () => {
    const reviews = [review("codex", "request-changes"), review("codex", "approve")];
    expect(latestChangeRequestNotes(reviews, 62, HEAD)).toBeNull();
    expect(latestChangeRequestNotes([], 62, HEAD)).toBeNull();
  });
});

describe("assembleFacts", () => {
  const base = { issue, author: "claude", pr, checks: "pass" as const, mergeable: "clean" as const, localRounds: 0, cfg: DEFAULT_CONFIG };

  it("reads cross-review approval of the current head", () => {
    const facts = assembleFacts({ ...base, reviews: [review("codex", "approve")] });
    expect(facts.review).toEqual({ approved: true, changesRequested: false });
    expect(facts.pr).toEqual({ number: 62, head: HEAD, checks: "pass", mergeable: "clean" });
  });

  it("does not count an approval of an older head", () => {
    expect(assembleFacts({ ...base, reviews: [review("codex", "approve", { head: OLD })] }).review.approved).toBe(false);
  });

  it("flags a current-head change request", () => {
    expect(assembleFacts({ ...base, reviews: [review("codex", "request-changes")] }).review)
      .toEqual({ approved: false, changesRequested: true });
  });

  it("counts a marked self-review only under cross-or-self", () => {
    const reviews = [review("claude", "approve", { mode: "self" })];
    expect(assembleFacts({ ...base, reviews }).review.approved).toBe(true);
    const strict: OrchConfig = { ...DEFAULT_CONFIG, reviewPolicy: "cross" };
    expect(assembleFacts({ ...base, reviews, cfg: strict }).review.approved).toBe(false);
  });

  it("treats everything as approved when cross-review is not required", () => {
    const cfg: OrchConfig = { ...DEFAULT_CONFIG, requireCrossReview: false };
    expect(assembleFacts({ ...base, reviews: [], cfg }).review.approved).toBe(true);
  });

  it("takes the larger of the PR's answered history and the local log as the round count", () => {
    // One request on an older head (answered by a fix) and one still pending on the current head.
    const reviews = [review("codex", "request-changes", { head: OLD }), review("codex", "request-changes")];
    expect(assembleFacts({ ...base, reviews, localRounds: 0 }).rounds).toBe(1);
    expect(assembleFacts({ ...base, reviews, localRounds: 5 }).rounds).toBe(5);
  });

  it("does not count the change request that is still waiting for its fix", () => {
    expect(assembleFacts({ ...base, reviews: [review("codex", "request-changes")] }).rounds).toBe(0);
    expect(assembleFacts({ ...base, reviews: [review("codex", "request-changes", { head: OLD })] }).rounds).toBe(1);
  });

  it("carries the attention label, round budget and merge policy", () => {
    const cfg: OrchConfig = { ...DEFAULT_CONFIG, maxReviewRounds: 7, requireHumanMerge: true };
    const facts = assembleFacts({ ...base, reviews: [], cfg, issue: { ...issue, labels: ["agent:claude", "needs-attention"] } });
    expect(facts).toMatchObject({ attention: true, maxRounds: 7, requireHumanMerge: true });
  });
});

describe("observeTasks", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(gh.listIssues).mockResolvedValue([issue]);
    vi.mocked(gh.listOpenPrs).mockResolvedValue([pr]);
    vi.mocked(gh.listPrReviews).mockResolvedValue([]);
    vi.mocked(gh.prChecksState).mockResolvedValue("pass");
    vi.mocked(gh.prMergeability).mockResolvedValue("clean");
  });

  it("derives the next step for each orch-owned task PR", async () => {
    const { tasks: [task], unobserved } = await observeTasks(DEFAULT_CONFIG, "/repo");
    expect(task).toMatchObject({ author: "claude", step: { kind: "review" }, feedback: null });
    expect(task.pr.number).toBe(62);
    expect(unobserved).toEqual([]);
  });

  it("surfaces the reviewer's notes and routes the PR back to the author", async () => {
    vi.mocked(gh.listPrReviews).mockResolvedValue([review("codex", "request-changes", { note: "add a test" })]);
    const { tasks: [task] } = await observeTasks(DEFAULT_CONFIG, "/repo");
    expect(task.step).toEqual({ kind: "fix", reason: "review" });
    expect(task.feedback).toBe("add a test");
  });

  it("skips PRs it does not own: no issue, unknown author, unmapped branch", async () => {
    vi.mocked(gh.listIssues).mockResolvedValue([{ ...issue, labels: ["agent:ghost"] }]);
    expect(await observeTasks(DEFAULT_CONFIG, "/repo")).toEqual({ tasks: [], unobserved: [] });
    vi.mocked(gh.listIssues).mockResolvedValue([]);
    expect(await observeTasks(DEFAULT_CONFIG, "/repo")).toEqual({ tasks: [], unobserved: [] });
    vi.mocked(gh.listIssues).mockResolvedValue([issue]);
    vi.mocked(gh.listOpenPrs).mockResolvedValue([{ ...pr, headRefName: "random", body: "no ref" }]);
    expect(await observeTasks(DEFAULT_CONFIG, "/repo")).toEqual({ tasks: [], unobserved: [] });
  });

  it("skips just the PR it cannot observe and keeps the rest", async () => {
    const other = { ...pr, number: 63, headRefName: "task/39-y", body: "Closes #39" };
    vi.mocked(gh.listIssues).mockResolvedValue([issue, { ...issue, number: 39 }]);
    vi.mocked(gh.listOpenPrs).mockResolvedValue([pr, other]);
    vi.mocked(gh.prMergeability).mockImplementation(async (n) => {
      if (n === 62) throw new Error("gh exploded");
      return "clean";
    });
    const { tasks, unobserved } = await observeTasks(DEFAULT_CONFIG, "/repo");
    expect(tasks.map((t) => t.pr.number)).toEqual([63]);
    expect(unobserved).toEqual([62]); // reported, so the caller cannot mistake it for "done"
  });

  it("reports every PR it could not read when none can be", async () => {
    vi.mocked(gh.listPrReviews).mockRejectedValue(new Error("rate limited"));
    expect(await observeTasks(DEFAULT_CONFIG, "/repo")).toEqual({ tasks: [], unobserved: [62] });
  });

  describe("round budget through the real observation-to-decision pipeline", () => {
    const withBudget = (maxReviewRounds: number): OrchConfig => ({ ...DEFAULT_CONFIG, maxReviewRounds });
    /** `answered` change requests on earlier heads (each answered by a fix), plus one pending on the current head. */
    const history = (answered: number, pending: boolean) => [
      ...Array.from({ length: answered }, (_, i) => review("codex", "request-changes", { head: String(i).repeat(40) })),
      ...(pending ? [review("codex", "request-changes")] : []),
    ];

    it("lets the author fix a first change request even when the budget is a single round", async () => {
      vi.mocked(gh.listPrReviews).mockResolvedValue(history(0, true));
      const { tasks: [task] } = await observeTasks(withBudget(1), "/repo");

      expect(task.facts.rounds).toBe(0);
      expect(task.step).toEqual({ kind: "fix", reason: "review" });
    });

    it("escalates a second change request once that single round has been spent", async () => {
      vi.mocked(gh.listPrReviews).mockResolvedValue(history(1, true));
      const { tasks: [task] } = await observeTasks(withBudget(1), "/repo");

      expect(task.facts.rounds).toBe(1);
      expect(task.step.kind).toBe("escalate");
    });

    it("allows the full default budget of three fixes, and escalates on the fourth request", async () => {
      for (const [answered, expected] of [[0, "fix"], [1, "fix"], [2, "fix"], [3, "escalate"]] as const) {
        vi.mocked(gh.listPrReviews).mockResolvedValue(history(answered, true));
        const { tasks: [task] } = await observeTasks(DEFAULT_CONFIG, "/repo");
        expect(task.facts.rounds, `${answered} answered`).toBe(answered);
        expect(task.step.kind, `${answered} answered`).toBe(expected);
      }
    });

    it("treats repeated requests on one unchanged head as a single pending fix, not spent rounds", async () => {
      // Two reviewers (or one repeated review) ask for changes on the same head before any fix happens.
      vi.mocked(gh.listPrReviews).mockResolvedValue([
        review("codex", "request-changes"), review("claude", "request-changes"), review("codex", "request-changes"),
      ]);
      const { tasks: [task] } = await observeTasks(withBudget(1), "/repo");

      expect(task.facts.rounds).toBe(0);
      expect(task.step).toEqual({ kind: "fix", reason: "review" }); // NOT escalated before the first fix
    });

    it("counts answered requests as spent once the head moved on (no pending request)", async () => {
      vi.mocked(gh.listPrReviews).mockResolvedValue(history(2, false));
      const { tasks: [task] } = await observeTasks(DEFAULT_CONFIG, "/repo");

      expect(task.facts.rounds).toBe(2);
      expect(task.step).toEqual({ kind: "review" });
    });
  });
});
