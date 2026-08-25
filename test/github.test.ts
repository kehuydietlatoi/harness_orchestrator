import { beforeEach, describe, expect, it, vi } from "vitest";

const execMock = vi.fn();
vi.mock("../src/util/exec.js", () => ({ exec: (...args: unknown[]) => execMock(...args) }));

const { listIssues, listOpenPrs, listLabels } = await import("../src/github/github.js");

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
