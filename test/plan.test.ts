import { describe, it, expect } from "vitest";
import { parseTickets, renderTicketBody, resolvePlan } from "../src/tasks/plan.js";

describe("renderTicketBody", () => {
  it("includes body, file-ownership hints, and resolved deps", () => {
    const body = renderTicketBody(
      { title: "x", body: "do the thing", files: ["src/a.ts", "src/b.ts"] },
      [3, 4],
    );
    expect(body).toContain("do the thing");
    expect(body).toContain("`src/a.ts`");
    expect(body).toContain("Depends-on: #3, #4");
  });

  it("falls back to a placeholder for an empty ticket", () => {
    expect(renderTicketBody({ title: "x" }, [])).toBe("_(no description)_");
  });
});

describe("parseTickets", () => {
  it("parses a ticket array and coerces missing optional fields", () => {
    const tickets = parseTickets(
      '[{"id":"a","title":"T","body":"b","dependsOn":["x"],"files":["f"]},{"title":"U"}]',
    );
    expect(tickets[0]).toEqual({ id: "a", title: "T", body: "b", dependsOn: ["x"], files: ["f"] });
    expect(tickets[1]).toEqual({ id: undefined, title: "U", body: undefined, dependsOn: undefined, files: undefined });
  });

  it("throws when the top level is not an array", () => {
    expect(() => parseTickets('{"title":"x"}')).toThrow(/must be a JSON array/i);
  });

  it("throws when an entry is not an object", () => {
    expect(() => parseTickets("[42]")).toThrow(/ticket 1 must be an object/i);
  });

  it("strips a leading BOM", () => {
    expect(parseTickets("﻿[]")).toEqual([]);
  });
});

describe("resolvePlan", () => {
  it("resolves earlier deps and reports nothing for a clean plan", () => {
    const r = resolvePlan([
      { title: "A", id: "a", files: ["src/a.ts"] },
      { title: "B", id: "b", dependsOn: ["a"], files: ["src/b.ts"] },
    ]);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.tickets[1].knownDeps).toEqual(["a"]);
  });

  it("errors on a missing title and a duplicate id", () => {
    const r = resolvePlan([
      { title: "", id: "a" },
      { title: "B", id: "a" },
    ]);
    expect(r.errors).toEqual(["ticket 1 needs a title", 'ticket 2: duplicate id "a"']);
  });

  it("warns and drops an unknown/later dependency", () => {
    const r = resolvePlan([
      { title: "A", id: "a", dependsOn: ["later"] },
      { title: "B", id: "later" },
    ]);
    expect(r.tickets[0].knownDeps).toEqual([]);
    expect(r.warnings.some((w) => /unknown\/later id "later"/.test(w))).toBe(true);
  });

  it("warns on a self dependency", () => {
    const r = resolvePlan([{ title: "A", id: "a", dependsOn: ["a"] }]);
    expect(r.warnings.some((w) => /depends on itself/.test(w))).toBe(true);
    expect(r.tickets[0].knownDeps).toEqual([]);
  });

  it("warns when two tickets claim the same file", () => {
    const r = resolvePlan([
      { title: "A", files: ["src/x.ts"] },
      { title: "B", files: ["src/x.ts"] },
    ]);
    expect(r.warnings.some((w) => /file "src\/x\.ts" is claimed by tickets 1, 2/.test(w))).toBe(true);
  });
});
