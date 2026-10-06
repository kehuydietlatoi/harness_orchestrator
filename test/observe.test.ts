import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, type OrchConfig } from "../src/config.js";
import { countChangeRequests, formatReview, latestChangeRequestNotes } from "../src/board/approval.js";

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
  it("counts every change request across heads, and nothing else", () => {
    const reviews = [review("codex", "request-changes", { head: OLD }), review("codex", "approve"), review("codex", "request-changes")];
    expect(countChangeRequests(reviews, 62)).toBe(2);
    expect(countChangeRequests(reviews, 99)).toBe(0);
    expect(countChangeRequests([{ id: 1, state: "COMMENTED", commit_id: HEAD, body: "hand-written" }], 62)).toBe(0);
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

  it("takes the larger of the PR's history and the local log as the round count", () => {
    const reviews = [review("codex", "request-changes", { head: OLD }), review("codex", "request-changes")];
    expect(assembleFacts({ ...base, reviews, localRounds: 0 }).rounds).toBe(2);
    expect(assembleFacts({ ...base, reviews, localRounds: 5 }).rounds).toBe(5);
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
    const [task] = await observeTasks(DEFAULT_CONFIG, "/repo");
    expect(task).toMatchObject({ author: "claude", step: { kind: "review" }, feedback: null });
    expect(task.pr.number).toBe(62);
  });

  it("surfaces the reviewer's notes and routes the PR back to the author", async () => {
    vi.mocked(gh.listPrReviews).mockResolvedValue([review("codex", "request-changes", { note: "add a test" })]);
    const [task] = await observeTasks(DEFAULT_CONFIG, "/repo");
    expect(task.step).toEqual({ kind: "fix", reason: "review" });
    expect(task.feedback).toBe("add a test");
  });

  it("skips PRs it does not own: no issue, unknown author, unmapped branch", async () => {
    vi.mocked(gh.listIssues).mockResolvedValue([{ ...issue, labels: ["agent:ghost"] }]);
    expect(await observeTasks(DEFAULT_CONFIG, "/repo")).toEqual([]);
    vi.mocked(gh.listIssues).mockResolvedValue([]);
    expect(await observeTasks(DEFAULT_CONFIG, "/repo")).toEqual([]);
    vi.mocked(gh.listIssues).mockResolvedValue([issue]);
    vi.mocked(gh.listOpenPrs).mockResolvedValue([{ ...pr, headRefName: "random", body: "no ref" }]);
    expect(await observeTasks(DEFAULT_CONFIG, "/repo")).toEqual([]);
  });

  it("skips just the PR it cannot observe and keeps the rest", async () => {
    const other = { ...pr, number: 63, headRefName: "task/39-y", body: "Closes #39" };
    vi.mocked(gh.listIssues).mockResolvedValue([issue, { ...issue, number: 39 }]);
    vi.mocked(gh.listOpenPrs).mockResolvedValue([pr, other]);
    vi.mocked(gh.prMergeability).mockImplementation(async (n) => {
      if (n === 62) throw new Error("gh exploded");
      return "clean";
    });
    const tasks = await observeTasks(DEFAULT_CONFIG, "/repo");
    expect(tasks.map((t) => t.pr.number)).toEqual([63]);
  });
});
