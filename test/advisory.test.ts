import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Issue } from "../src/github/github.js";
import { eligibleIssues, orderByAfter, parseAfter, parseDeps } from "../src/board/board.js";

const mocks = vi.hoisted(() => ({ listIssues: vi.fn(), getIssue: vi.fn(), isLocked: vi.fn() }));
vi.mock("../src/github/github.js", () => ({ listIssues: mocks.listIssues, getIssue: mocks.getIssue }));
vi.mock("../src/git/lock.js", () => ({ isLocked: mocks.isLocked }));

function issue(number: number, body = "", labels = ["status:todo"]): Issue {
  return { number, title: `Task ${number}`, body, labels, state: "OPEN", assignees: [] };
}
const numbers = (issues: Issue[]) => issues.map((i) => i.number);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.isLocked.mockResolvedValue(false);
});

describe("advisory references", () => {
  it("parses case-insensitive After lines separately and deduplicates", () => {
    const body = "Depends-on: #1, #2\r\n After: #3, #4, #3\r\naFtEr: #5\nProse after: #99";
    expect(parseDeps(body)).toEqual([1, 2]);
    expect(parseAfter(body)).toEqual([3, 4, 5]);
    expect(parseAfter("Thereafter: #7\nAfter #8\nDepends on #9")).toEqual([]);
  });

  it("prefers available predecessors transitively with stable number tie-breaking", () => {
    const candidates = [issue(1, "After: #3"), issue(2), issue(3, "After: #4"), issue(4)];
    expect(numbers(orderByAfter(candidates))).toEqual([2, 4, 3, 1]);
    expect(numbers(orderByAfter([...candidates].reverse()))).toEqual([2, 4, 3, 1]);
    expect(numbers(candidates)).toEqual([1, 2, 3, 4]);
  });

  it("keeps advisory cycles dispatchable in deterministic number order", () => {
    const candidates = [issue(3, "After: #1"), issue(1, "After: #2"), issue(2, "After: #3")];
    expect(numbers(orderByAfter(candidates))).toEqual([1, 2, 3]);
    expect(numbers(orderByAfter([issue(1, "After: #1"), issue(2)]))).toEqual([2, 1]);
    expect(orderByAfter([])).toEqual([]);
  });
});

describe("eligible advisory scheduling", () => {
  it.each(["blocked", "claimed", "locked", "missing", "closed"])(
    "a %s predecessor never withholds its advisory successor, but an open hard prerequisite does",
    async (state) => {
      const predecessor = issue(38, state === "blocked" ? "Depends-on: #99" : "",
        state === "claimed" ? ["status:claimed"] : ["status:todo"]);
      const open = [issue(40, "After: #38"), issue(41, "Depends-on: #38\nAfter: #38")];
      if (state !== "missing" && state !== "closed") open.push(predecessor);
      if (state === "blocked") open.push(issue(99, "", ["status:in-progress"]));
      mocks.isLocked.mockImplementation(async (n: number) => state === "locked" && n === 38);
      mocks.listIssues.mockResolvedValue(open);

      expect(numbers(await eligibleIssues("/repo"))).toEqual(
        state === "missing" || state === "closed" ? [40, 41] : [40],
      );
      expect(mocks.listIssues).toHaveBeenCalledTimes(1);
      expect(mocks.listIssues).toHaveBeenCalledWith({ cwd: "/repo", state: "open" });
      expect(mocks.getIssue).not.toHaveBeenCalled();
    },
  );

  it("combines hard and advisory edges without turning mixed cycles into hard deadlocks", async () => {
    mocks.listIssues.mockResolvedValue([
      issue(1, "After: #2"), issue(2, "Depends-on: #1"),
      issue(3, "After: #4"), issue(4, "After: #3"), issue(5),
    ]);
    expect(numbers(await eligibleIssues())).toEqual([1, 5, 3, 4]);
  });

  it("filters another agent's ownership before applying advisory preferences", async () => {
    mocks.listIssues.mockResolvedValue([
      issue(1, "After: #3", ["status:todo", "agent:codex"]),
      issue(2), issue(3, "", ["status:todo", "agent:claude"]),
    ]);
    expect(numbers(await eligibleIssues("/repo", "codex"))).toEqual([1, 2]);
    expect(numbers(await eligibleIssues("/repo"))).toEqual([2, 3, 1]);
  });
});
