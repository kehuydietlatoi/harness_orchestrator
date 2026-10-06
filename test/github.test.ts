import { beforeEach, describe, expect, it, vi } from "vitest";

const execMock = vi.fn();
vi.mock("../src/util/exec.js", () => ({ exec: (...args: unknown[]) => execMock(...args) }));

const { listIssues, listOpenPrs, listPrs, listLabels, getBranchPrs, getIssueReferencedPrs } = await import("../src/github/github.js");
const { mergePr, recordPrReview, listPrReviews, prChecksState } = await import("../src/github/github.js");

describe("prChecksState", () => {
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
