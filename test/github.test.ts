import { beforeEach, describe, expect, it, vi } from "vitest";

const execMock = vi.fn();
vi.mock("../src/util/exec.js", () => ({ exec: (...args: unknown[]) => execMock(...args) }));

const { listIssues, listOpenPrs, listPrs, listLabels, getBranchPrs, getIssueReferencedPrs } = await import("../src/github/github.js");
const { mergePr, recordPrReview, listPrReviews, prChecksState, prDiff, closeIssue } = await import("../src/github/github.js");
const { prChangedPaths, prMergeability, latestLabelRemoval } = await import("../src/github/github.js");

describe("issue label handbacks", () => {
  beforeEach(() => execMock.mockReset());
  const event = (created_at: string, name = "needs-attention", kind = "unlabeled") => ({ event: kind, label: { name }, created_at });
  const page = (items: unknown[]) => ({ code: 0, stderr: "", stdout: JSON.stringify(items) });
  it("paginates issue events and chooses the newest matching removal", async () => {
    execMock.mockResolvedValueOnce(page(Array.from({ length: 100 }, () => event("2026-10-20T09:00:00Z"))))
      .mockResolvedValueOnce(page([event("2026-10-20T11:00:00Z"), event("2026-10-20T12:00:00Z", "other"),
        event("2026-10-20T13:00:00Z", "needs-attention", "labeled"), event("2026-10-20T10:00:00Z")]));
    expect(await latestLabelRemoval(218, "needs-attention", { cwd: "/repo" })).toBe("2026-10-20T11:00:00Z");
    expect(execMock.mock.calls[1][1][1]).toBe("repos/{owner}/{repo}/issues/218/events?per_page=100&page=2");
  });
  it("returns null when there was no matching removal", async () => {
    execMock.mockResolvedValueOnce(page([event("2026-10-20T11:00:00Z", "other")]));
    expect(await latestLabelRemoval(218, "needs-attention")).toBeNull();
  });
  it("propagates unreadable events and malformed removal times", async () => {
    execMock.mockResolvedValueOnce({ code: 1, stdout: "", stderr: "offline" });
    await expect(latestLabelRemoval(218, "needs-attention")).rejects.toThrow("offline");
    execMock.mockResolvedValueOnce(page([event("bad date")]));
    await expect(latestLabelRemoval(218, "needs-attention")).rejects.toThrow("Invalid issue label removal time");
  });
});

describe("head-bound mergeability", () => {
  const head = "a".repeat(40);
  const base = "b".repeat(40);
  const response = (mergeable: boolean | null, sha = head, prBase = base) => ({
    code: 0, stderr: "", stdout: JSON.stringify({ head: { sha }, base: { sha: prBase, ref: "studio" }, mergeable }),
  });
  /** The base branch's current tip, read separately: a pull's `base.sha` lags the branch. */
  const tip = (sha = base) => ({ code: 0, stderr: "", stdout: JSON.stringify({ object: { sha } }) });
  beforeEach(() => execMock.mockReset());

  it("judges a conflict against the base branch's current tip, not the pull's stale base.sha (#239)", async () => {
    const stale = "d".repeat(40);
    execMock.mockResolvedValueOnce(response(false, head, stale)).mockResolvedValueOnce(tip(base))
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "" });
    expect(await prMergeability(239, { cwd: "/repo", head })).toBe("conflicting");
    expect(execMock.mock.calls[1]).toEqual(["gh", ["api", "repos/{owner}/{repo}/git/ref/heads/studio"], { cwd: "/repo" }]);
    expect(execMock).toHaveBeenLastCalledWith("git", ["merge-base", "--is-ancestor", base, head], { cwd: "/repo" });
  });

  it("waits when the base branch tip cannot be read", async () => {
    execMock.mockResolvedValueOnce(response(false)).mockResolvedValueOnce({ code: 1, stdout: "", stderr: "HTTP 502" });
    expect(await prMergeability(62, { head })).toBe("unknown");
    expect(execMock).toHaveBeenCalledTimes(2);
  });

  it("treats a stale conflict on a pushed head containing the base as unknown", async () => {
    execMock.mockResolvedValueOnce(response(false)).mockResolvedValueOnce(tip()).mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });
    expect(await prMergeability(62, { cwd: "/repo", head })).toBe("unknown");
    expect(execMock).toHaveBeenLastCalledWith("git", ["merge-base", "--is-ancestor", base, head], { cwd: "/repo" });
  });

  it("keeps a conflict with a newer base actionable", async () => {
    execMock.mockResolvedValueOnce(response(false)).mockResolvedValueOnce(tip()).mockResolvedValueOnce({ code: 1, stdout: "", stderr: "" });
    expect(await prMergeability(62, { head })).toBe("conflicting");
  });

  it.each([response(null), response(false, "c".repeat(40))])("waits for unknown or mismatched head results", async (result) => {
    execMock.mockResolvedValueOnce(result);
    expect(await prMergeability(62, { head })).toBe("unknown");
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  it("accepts a computed clean result for the requested head", async () => {
    execMock.mockResolvedValueOnce(response(true));
    expect(await prMergeability(62, { head })).toBe("clean");
  });

  it("fetches missing objects before checking a new base", async () => {
    execMock.mockResolvedValueOnce(response(false)).mockResolvedValueOnce(tip())
      .mockResolvedValueOnce({ code: 128, stdout: "", stderr: "missing object" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "" });
    expect(await prMergeability(62, { head })).toBe("conflicting");
    expect(execMock.mock.calls[3][1]).toEqual(["fetch", "--no-tags", "origin", base, head]);
  });

  it("does not turn an unreadable ancestry into a conflict", async () => {
    execMock.mockResolvedValueOnce(response(false)).mockResolvedValueOnce(tip())
      .mockResolvedValueOnce({ code: 128, stdout: "", stderr: "missing object" })
      .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "offline" });
    expect(await prMergeability(62, { head })).toBe("unknown");
  });
});

describe("prChangedPaths", () => {
  beforeEach(() => execMock.mockReset());
  it("paginates and retains both sides of renames and deleted paths", async () => {
    execMock.mockResolvedValueOnce({ code: 0, stderr: "", stdout: JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ filename: `src/${i}.ts` }))) });
    execMock.mockResolvedValueOnce({ code: 0, stderr: "", stdout: JSON.stringify([
      { filename: "old-config.txt", previous_filename: "vitest.config.ts", status: "renamed" },
      { filename: "orch.config.json", status: "removed" },
    ]) });
    const paths = await prChangedPaths(7, { cwd: "/repo" });
    expect(paths).toHaveLength(103);
    expect(paths.slice(-3)).toEqual(["old-config.txt", "vitest.config.ts", "orch.config.json"]);
    expect(execMock.mock.calls[1][1][1]).toContain("page=2");
  });
  it("throws instead of treating a failed file read as no protected changes", async () => {
    execMock.mockResolvedValueOnce({ code: 1, stdout: "", stderr: "offline" });
    await expect(prChangedPaths(7)).rejects.toThrow(/offline/);
  });
});

describe("closeIssue", () => {
  beforeEach(() => execMock.mockReset());

  it("throws on a non-zero gh exit", async () => {
    execMock.mockResolvedValueOnce({ code: 1, stdout: "", stderr: "network error\n" });
    await expect(closeIssue(65, { cwd: "/repo" })).rejects.toThrow("gh issue close #65 failed: network error");
    expect(execMock).toHaveBeenCalledWith("gh", ["issue", "close", "65"], { cwd: "/repo" });
  });

  it("succeeds when gh warns that the issue is already closed", async () => {
    execMock.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "Issue #65 is already closed" });
    await expect(closeIssue(65)).resolves.toBeUndefined();
  });
});

describe("prDiff", () => {
  beforeEach(() => execMock.mockReset());

  it("returns a diff without escapes unchanged, strict or not", async () => {
    for (const strict of [false, true]) {
      execMock.mockResolvedValueOnce({ code: 0, stdout: "diff --git a/x b/x\n", stderr: "" });
      expect(await prDiff(7, { strict })).toBe("diff --git a/x b/x\n");
    }
  });

  it("allows escape sequences and renders every ESC visibly, strict or not", async () => {
    const diff = "diff --git a/stderr b/stderr\n+\u001b[31merror\u001b[0m\n+\u001b]0;title\u0007\n+\u001b";
    for (const strict of [false, true]) {
      execMock.mockResolvedValueOnce({ code: 0, stdout: diff, stderr: "" });
      const result = await prDiff(7, { cwd: "/repo", strict });
      expect(result).toBe("diff --git a/stderr b/stderr\n+<ESC>[31merror<ESC>[0m\n+<ESC>]0;title\u0007\n+<ESC>");
      expect(result).not.toContain("\u001b");
      expect(execMock).toHaveBeenLastCalledWith("gh", ["pr", "diff", "7", "--allow-escape-sequences"], { cwd: "/repo" });
    }
  });

  it("hands a human reader a readable message on failure, but a reviewer an ERROR (never fake diff text)", async () => {
    const failure = { code: 1, stdout: "", stderr: "HTTP 406: diff exceeded the maximum number of lines (20000)" };

    execMock.mockResolvedValueOnce(failure);
    expect(await prDiff(7)).toBe("(diff unavailable: HTTP 406: diff exceeded the maximum number of lines (20000))");

    execMock.mockResolvedValueOnce(failure);
    await expect(prDiff(7, { strict: true })).rejects.toThrow(/could not fetch the diff of PR #7: HTTP 406/);
  });

  it("strict mode names the exit code when gh said nothing", async () => {
    execMock.mockResolvedValueOnce({ code: 137, stdout: "", stderr: "" });
    await expect(prDiff(7, { strict: true })).rejects.toThrow("exit 137");
  });
});

describe("prChecksState", () => {
  it("ignores failed observe statuses when computing CI", async () => {
    execMock.mockResolvedValueOnce({ code: 1, stdout: JSON.stringify([{ name: "studio/observe", bucket: "fail" }, { name: "test", bucket: "pass" }]), stderr: "" });
    expect(await prChecksState(1, { strict: true })).toBe("pass");
    expect(execMock.mock.calls.at(-1)?.[1]).toContain("bucket,state,name");
  });
  const results = (...buckets: string[]) => JSON.stringify(buckets.map((bucket) => ({ bucket, state: "X" })));
  const gh = (code: number, stdout: string, stderr = "") => ({ code, stdout, stderr });
  beforeEach(() => execMock.mockReset());

  it("reads the results gh printed whatever its exit code (it exits non-zero while checks fail or are pending)", async () => {
    for (const strict of [false, true]) {
      execMock.mockResolvedValueOnce(gh(0, results("pass", "pass")));
      expect(await prChecksState(1, { strict })).toBe("pass");
      execMock.mockResolvedValueOnce(gh(1, results("pass", "fail")));
      expect(await prChecksState(1, { strict })).toBe("fail");
      execMock.mockResolvedValueOnce(gh(8, results("pass", "pending")));
      expect(await prChecksState(1, { strict })).toBe("pending");
      execMock.mockResolvedValueOnce(gh(1, results("cancel")));
      expect(await prChecksState(1, { strict })).toBe("fail");
    }
  });

  it("treats 'no checks reported' as none, strict or not", async () => {
    for (const strict of [false, true]) {
      execMock.mockResolvedValueOnce(gh(1, "", "no checks reported on the 'x' branch"));
      expect(await prChecksState(1, { strict })).toBe("none");
    }
  });

  it("a failed lookup is red to the lenient dashboard reader but an ERROR to the strict one", async () => {
    const error = gh(1, "", "GraphQL: Could not resolve to a PullRequest with the number of 999999.");

    execMock.mockResolvedValueOnce(error);
    expect(await prChecksState(999999)).toBe("fail"); // unchanged: the dashboard keeps its conservative display

    execMock.mockResolvedValueOnce(error);
    await expect(prChecksState(999999, { strict: true })).rejects.toThrow(
      /could not read the checks of PR #999999: GraphQL: Could not resolve/,
    );
  });

  it("strict mode also rejects unreadable output, with or without a failing exit code", async () => {
    execMock.mockResolvedValueOnce(gh(1, "<html>rate limited</html>"));
    await expect(prChecksState(1, { strict: true })).rejects.toThrow("rate limited");
    execMock.mockResolvedValueOnce(gh(0, "not json"));
    await expect(prChecksState(1, { strict: true })).rejects.toThrow("could not read the checks of PR #1");
    execMock.mockResolvedValueOnce(gh(137, ""));
    await expect(prChecksState(1, { strict: true })).rejects.toThrow("exit 137");
  });

  it("is lenient unless asked otherwise", async () => {
    execMock.mockResolvedValueOnce(gh(1, "", "network is unreachable"));
    expect(await prChecksState(1)).toBe("fail");
  });
});

describe("commit-bound review transport", () => {
  it("sends an expected-head merge and checks GitHub actually merged", async () => {
    execMock.mockResolvedValueOnce(ok({ merged: true }));
    await mergePr(62, { expectedHead: "a".repeat(40), cwd: "/repo" });
    expect(execMock.mock.calls[0][1]).toEqual(["api", "repos/{owner}/{repo}/pulls/62/merge", "--method", "PUT", "--input", "-"]);
    expect(JSON.parse(execMock.mock.calls[0][2].input)).toEqual({ sha: "a".repeat(40), merge_method: "squash" });
    // A squash merge carries the PR title, not whatever the first commit happened to be called.
    execMock.mockResolvedValueOnce(ok({ merged: true }));
    await mergePr(62, { expectedHead: "a".repeat(40), title: "fix: the real title" });
    expect(JSON.parse(execMock.mock.calls[1][2].input)).toEqual({
      sha: "a".repeat(40), merge_method: "squash", commit_title: "fix: the real title (#62)",
    });
    // ...but a non-squash merge keeps GitHub's default merge message.
    execMock.mockResolvedValueOnce(ok({ merged: true }));
    await mergePr(62, { expectedHead: "a".repeat(40), title: "fix: the real title", method: "merge" });
    expect(JSON.parse(execMock.mock.calls[2][2].input)).toEqual({ sha: "a".repeat(40), merge_method: "merge" });
    execMock.mockResolvedValueOnce(ok({ merged: false }));
    await expect(mergePr(62, { expectedHead: "a".repeat(40) })).rejects.toThrow("did not merge");
    execMock.mockResolvedValueOnce({ code: 1, stdout: "", stderr: "HTTP 409 head changed" });
    await expect(mergePr(62, { expectedHead: "a".repeat(40) })).rejects.toThrow("409");
  });
  it("records a COMMENT review with an explicit commit and paginates reads", async () => {
    execMock.mockResolvedValueOnce(ok({}));
    await recordPrReview(62, "a".repeat(40), "body", { cwd: "/repo" });
    expect(JSON.parse(execMock.mock.calls[0][2].input)).toEqual({ event: "COMMENT", commit_id: "a".repeat(40), body: "body" });
    execMock.mockResolvedValueOnce(ok(Array.from({ length: 100 }, (_, id) => ({ id })))).mockResolvedValueOnce(ok([{ id: 100 }]));
    expect(await listPrReviews(62)).toHaveLength(101);
  });
});

function restIssue(n: number, over: Record<string, unknown> = {}) {
  return {
    number: n,
    title: `issue ${n}`,
    body: "",
    state: "open",
    labels: [{ name: "bug" }],
    assignees: [{ login: "alice" }],
    ...over,
  };
}

function ok(body: unknown) {
  return { code: 0, stdout: JSON.stringify(body), stderr: "" };
}

beforeEach(() => execMock.mockReset());

describe("listIssues", () => {
  it("aggregates a full 100-item page plus a short second page", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => restIssue(i + 1));
    const page2 = Array.from({ length: 30 }, (_, i) => restIssue(101 + i));
    execMock.mockResolvedValueOnce(ok(page1)).mockResolvedValueOnce(ok(page2));

    const issues = await listIssues({ cwd: "/repo" });

    expect(issues).toHaveLength(130);
    expect(issues[0].number).toBe(1);
    expect(issues[129].number).toBe(130);
    expect(execMock).toHaveBeenCalledTimes(2);
    expect(execMock.mock.calls[0][1][1]).toContain("page=1");
    expect(execMock.mock.calls[1][1][1]).toContain("page=2");
  });

  it("stops after a single short page instead of over-fetching", async () => {
    execMock.mockResolvedValueOnce(ok([restIssue(1)]));

    const issues = await listIssues();

    expect(issues).toHaveLength(1);
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  it("filters out pull requests returned by the /issues endpoint", async () => {
    execMock.mockResolvedValueOnce(ok([restIssue(1), restIssue(2, { pull_request: {} })]));

    const issues = await listIssues();

    expect(issues.map((i) => i.number)).toEqual([1]);
  });

  it("maps state, labels, and assignees from the REST shape", async () => {
    execMock.mockResolvedValueOnce(ok([restIssue(1)]));

    const [issue] = await listIssues();

    expect(issue.state).toBe("OPEN");
    expect(issue.labels).toEqual(["bug"]);
    expect(issue.assignees).toEqual(["alice"]);
  });

  it("throws with the gh error when a page request fails", async () => {
    execMock.mockResolvedValueOnce({ code: 1, stdout: "", stderr: "boom" });

    await expect(listIssues()).rejects.toThrow(/gh api.*boom/);
  });
});

describe("listOpenPrs", () => {
  it("aggregates across pages and maps head.ref to headRefName", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      number: i + 1,
      title: `pr ${i + 1}`,
      body: "",
      state: "open",
      head: { ref: `branch-${i + 1}` },
    }));
    const page2 = [{ number: 101, title: "pr 101", body: "", state: "open", head: { ref: "branch-101" } }];
    execMock.mockResolvedValueOnce(ok(page1)).mockResolvedValueOnce(ok(page2));

    const prs = await listOpenPrs();

    expect(prs).toHaveLength(101);
    expect(prs[100].headRefName).toBe("branch-101");
    expect(execMock).toHaveBeenCalledTimes(2);
  });

  it("distinguishes merged PRs when listing all lifecycle history", async () => {
    execMock.mockResolvedValueOnce(
      ok([
        {
          number: 102,
          title: "merged",
          body: "Closes #36",
          state: "closed",
          merged_at: "2026-08-27T10:00:00Z",
          head: { ref: "task/36-repair" },
        },
      ]),
    );

    const [merged] = await listPrs({ state: "all" });

    expect(merged.state).toBe("MERGED");
    expect(execMock.mock.calls[0][1][1]).toContain("state=all");
  });
});

describe("getBranchPrs", () => {
  it("queries only the requested head with a fixed limit and preserves PR states", async () => {
    execMock.mockResolvedValueOnce(ok([
      { number: 7, state: "CLOSED", headRefName: "task/1-x", url: "https://github.com/acme/orch/pull/7" },
      { number: 8, state: "MERGED", headRefName: "task/1-x" },
    ]));
    const prs = await getBranchPrs("task/1-x", { cwd: "/repo" });
    expect(prs.map((pr) => pr.state)).toEqual(["CLOSED", "MERGED"]);
    expect(prs[0].htmlUrl).toBe("https://github.com/acme/orch/pull/7");
    expect(execMock).toHaveBeenCalledWith("gh", ["pr", "list", "--head", "task/1-x", "--state", "all",
      "--limit", "100", "--json", "number,title,body,headRefName,state,url,headRefOid"], { cwd: "/repo" });
  });
  it("accepts an empty history but rejects failures and potentially truncated history", async () => {
    execMock.mockResolvedValueOnce(ok([]));
    expect(await getBranchPrs("task/1-x")).toEqual([]);
    execMock.mockResolvedValueOnce({ code: 1, stdout: "", stderr: "offline" });
    await expect(getBranchPrs("task/1-x")).rejects.toThrow("offline");
    execMock.mockResolvedValueOnce(ok(Array.from({ length: 100 }, (_, number) => ({ number }))));
    await expect(getBranchPrs("task/1-x")).rejects.toThrow("limit 100 reached");
  });
});

describe("getIssueReferencedPrs", () => {
  const response = (nodes: unknown[], hasNextPage = false) => ({ data: { repository: { issue: {
    timelineItems: { nodes, pageInfo: { hasNextPage } },
  } } } });
  it("reads one issue's references and excludes cross-repository PRs and issue mentions", async () => {
    const source = { __typename: "PullRequest", number: 9, state: "CLOSED", body: "Closes #1", headRefName: "custom" };
    execMock.mockResolvedValueOnce(ok(response([
      { isCrossRepository: false, source },
      { isCrossRepository: true, source: { ...source, number: 10 } },
      { isCrossRepository: false, source: { __typename: "Issue" } },
    ])));
    expect(await getIssueReferencedPrs(1)).toMatchObject([{ number: 9, state: "CLOSED", headRefName: "custom" }]);
    expect(execMock).toHaveBeenCalledOnce();
    expect(execMock.mock.calls[0][1]).toEqual(["api", "graphql", "-F", "owner={owner}", "-F", "name={repo}",
      "-F", "number=1", "-f", expect.stringContaining("timelineItems(first: 100, itemTypes: [CROSS_REFERENCED_EVENT])")]);
  });
  it("fails explicitly for missing, partial, truncated, or unavailable observations", async () => {
    for (const body of [{ data: { repository: { issue: null } } },
      { ...response([]), errors: [{ message: "partial response" }] }, response([], true)]) {
      execMock.mockResolvedValueOnce(ok(body));
      await expect(getIssueReferencedPrs(1)).rejects.toThrow("cannot observe");
    }
    execMock.mockResolvedValueOnce({ code: 1, stdout: "", stderr: "offline" });
    await expect(getIssueReferencedPrs(1)).rejects.toThrow("offline");
  });
});

describe("listLabels", () => {
  it("aggregates label names across pages", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ name: `label-${i + 1}` }));
    const page2 = [{ name: "label-101" }];
    execMock.mockResolvedValueOnce(ok(page1)).mockResolvedValueOnce(ok(page2));

    const names = await listLabels("/repo");

    expect(names).toHaveLength(101);
    expect(names).toContain("label-101");
  });

  it("returns [] instead of throwing when gh api fails", async () => {
    execMock.mockResolvedValueOnce({ code: 1, stdout: "", stderr: "boom" });

    expect(await listLabels()).toEqual([]);
  });
});


describe("milestones for plan creation", () => {
  beforeEach(() => execMock.mockReset());

  it("finds an existing milestone beyond the first page without creating it", async () => {
    const { ensureMilestone } = await import("../src/github/github.js");
    execMock.mockResolvedValueOnce({ code: 0, stdout: JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ title: 'Other ' + i }))) });
    execMock.mockResolvedValueOnce({ code: 0, stdout: JSON.stringify([{ title: "Phase 2" }]) });
    await ensureMilestone("Phase 2", "/repo");
    expect(execMock).toHaveBeenCalledTimes(2);
    expect(execMock.mock.calls[1][1][1]).toContain("page=2");
  });

  it("creates a missing milestone with literal title argv", async () => {
    const { ensureMilestone, createIssue } = await import("../src/github/github.js");
    execMock.mockResolvedValueOnce({ code: 0, stdout: "[]" });
    execMock.mockResolvedValueOnce({ code: 0, stdout: "{}" });
    await ensureMilestone("Phase 2", "/repo");
    expect(execMock.mock.calls[1]).toEqual(["gh", ["api", "repos/{owner}/{repo}/milestones", "--method", "POST", "--raw-field", "title=Phase 2"], { cwd: "/repo" }]);
    execMock.mockResolvedValueOnce({ code: 0, stdout: "https://github.com/o/r/issues/10" });
    await expect(createIssue("Ticket", "Body", ["status:todo"], { cwd: "/repo", milestone: "Phase 2" })).resolves.toBe(10);
    expect(execMock.mock.calls[2][1]).toContain("--milestone");
    expect(execMock.mock.calls[2][1]).toContain("Phase 2");
  });

  it("reconciles a concurrent create or lost response without retrying the write", async () => {
    const { ensureMilestone } = await import("../src/github/github.js");
    execMock.mockResolvedValueOnce({ code: 0, stdout: "[]" });
    execMock.mockResolvedValueOnce({ code: 1, stderr: "response lost" });
    execMock.mockResolvedValueOnce({ code: 0, stdout: JSON.stringify([{ title: "Phase 2" }]) });
    await expect(ensureMilestone("Phase 2")).resolves.toBeUndefined();
    expect(execMock).toHaveBeenCalledTimes(3);
  });

  it("fails closed when the milestone cannot be created", async () => {
    const { ensureMilestone } = await import("../src/github/github.js");
    execMock.mockResolvedValueOnce({ code: 0, stdout: "[]" });
    execMock.mockResolvedValueOnce({ code: 1, stderr: "permission denied" });
    execMock.mockResolvedValueOnce({ code: 0, stdout: "[]" });
    await expect(ensureMilestone("Phase 2")).rejects.toThrow("permission denied");
  });
});
