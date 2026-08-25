import { describe, it, expect } from "vitest";
import { byNumber, issueEffort, openDepsFromMap, parseDeps } from "../src/board/board.js";
import type { Issue } from "../src/github/github.js";

function issue(number: number, over: Partial<Issue> = {}): Issue {
  return {
    number,
    title: `#${number}`,
    body: "",
    state: "OPEN",
    labels: [],
    assignees: [],
    ...over,
  };
}

describe("parseDeps", () => {
  it("parses `Depends-on: #1, #2` and dedupes", () => {
    expect(parseDeps("Depends-on: #1, #2, #1")).toEqual([1, 2]);
  });
  it("parses `Depends on #3` variant", () => {
    expect(parseDeps("intro\nDepends on #3\n")).toEqual([3]);
  });
  it("returns [] when there are no deps", () => {
    expect(parseDeps("no deps here")).toEqual([]);
  });
});

describe("issueEffort", () => {
  it.each([
    ["easy", "easy"],
    ["hard", "hard"],
  ])("parses effort:%s", (tier, expected) => {
    expect(issueEffort(issue(1, { labels: [`effort:${tier}`] }))).toBe(expected);
  });

  it("returns null without a recognized effort label", () => {
    expect(issueEffort(issue(1, { labels: ["agent:claude", "effort:medium"] }))).toBeNull();
  });
});

describe("byNumber", () => {
  it("indexes issues by their number", () => {
    const map = byNumber([issue(1), issue(2)]);
    expect(map.get(2)?.number).toBe(2);
    expect(map.size).toBe(2);
  });
});

describe("openDepsFromMap", () => {
  const open = byNumber([issue(1), issue(2), issue(3, { state: "CLOSED" })]);

  it("returns open deps as blocking", () => {
    expect(openDepsFromMap(issue(9, { body: "Depends-on: #1, #2" }), open)).toEqual([1, 2]);
  });
  it("treats a closed dep as non-blocking", () => {
    // #3 is CLOSED in the map (kept for parity with getIssue semantics).
    expect(openDepsFromMap(issue(9, { body: "Depends-on: #3" }), open)).toEqual([]);
  });
  it("treats a dep missing from the map as non-blocking", () => {
    expect(openDepsFromMap(issue(9, { body: "Depends-on: #42" }), open)).toEqual([]);
  });
  it("returns [] when the issue has no deps", () => {
    expect(openDepsFromMap(issue(9), open)).toEqual([]);
  });
});
