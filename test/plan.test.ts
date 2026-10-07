import { describe, it, expect } from "vitest";
import { MAX_BRIEF_CHARS, parseTickets, resolvePlan } from "../src/tasks/plan.js";
import { renderTicketBody } from "../src/tasks/plan-create.js";

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
  it("accepts advisory IDs and rejects malformed after fields", () => {
    expect(parseTickets('[{"title":"B","after":["a"]}]')[0].after).toEqual(["a"]);
    for (const after of ["a", [1], null]) {
      expect(() => parseTickets(JSON.stringify([{ title: "B", after }]))).toThrow(/after must be an array of strings/);
    }
  });
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

  it("throws on a non-string id instead of silently dropping it", () => {
    expect(() => parseTickets('[{"id":1,"title":"T"}]')).toThrow(/ticket 1: id must be a string/);
  });

  it("throws on a non-string title instead of coercing it away", () => {
    expect(() => parseTickets('[{"title":5}]')).toThrow(/ticket 1: title must be a string/);
  });

  it("throws on a non-string body instead of silently dropping it", () => {
    expect(() => parseTickets('[{"title":"T","body":42}]')).toThrow(/ticket 1: body must be a string/);
  });

  it("throws when dependsOn is not an array of strings", () => {
    expect(() => parseTickets('[{"title":"T","dependsOn":"a"}]')).toThrow(
      /ticket 1: dependsOn must be an array of strings/,
    );
    expect(() => parseTickets('[{"title":"T","dependsOn":["a",2]}]')).toThrow(
      /ticket 1: dependsOn must be an array of strings/,
    );
  });

  it("throws when files is not an array of strings", () => {
    expect(() => parseTickets('[{"title":"T","files":[1,2]}]')).toThrow(
      /ticket 1: files must be an array of strings/,
    );
  });

  it("collects errors across multiple tickets and fields in one throw", () => {
    expect(() => parseTickets('[{"id":1,"title":"T"},{"title":"U","body":9}]')).toThrow(
      /ticket 1: id must be a string.*ticket 2: body must be a string/s,
    );
  });
});

/** Warnings about links and routing, ignoring the finish-line advisories (covered in "definition of done" below). */
const structural = (warnings: readonly string[]): string[] => warnings.filter((w) => !/definition of done|open-ended/.test(w));

describe("resolvePlan", () => {
  it("resolves earlier advisory IDs and warns on self, later, or unknown IDs", () => {
    const plan = resolvePlan([
      { id: "a", title: "A" },
      { id: "b", title: "B", after: ["a", "b", "c", "missing"] },
      { id: "c", title: "C" },
    ]);
    expect(plan.errors).toEqual([]);
    expect(plan.tickets[1]).toMatchObject({ after: ["a", "b", "c", "missing"], knownAfter: ["a"], knownDeps: [] });
    expect(structural(plan.warnings)).toEqual([
      'ticket 2 ("b") is after itself; dropped',
      'ticket 2 is after unknown/later id "c"; dropped',
      'ticket 2 is after unknown/later id "missing"; dropped',
    ]);
  });
  it("resolves earlier deps and reports nothing for a clean plan", () => {
    const r = resolvePlan([
      { title: "A", id: "a", files: ["src/a.ts"], acceptance: ["`npm test` passes"] },
      { title: "B", id: "b", dependsOn: ["a"], files: ["src/b.ts"], acceptance: ["a test covers B"] },
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

describe("plan routing and brief", () => {
  it("parses agent/effort and rejects non-string routing", () => {
    const [t] = parseTickets('[{"title":"x","agent":"codex","effort":"hard"}]');
    expect(t).toMatchObject({ agent: "codex", effort: "hard" });
    expect(() => parseTickets('[{"title":"x","agent":1,"effort":["hard"]}]')).toThrow(
      /ticket 1: agent must be a string; ticket 1: effort must be a string/,
    );
  });

  it("keeps valid routing and drops unknown agents, unknown efforts, and an effort without an agent", () => {
    const plan = resolvePlan(
      [
        { title: "ok", agent: "codex", effort: "hard" },
        { title: "agent only", agent: "claude" },
        { title: "stranger", agent: "gemini", effort: "easy" },
        { title: "bad tier", agent: "claude", effort: "medium" },
        { title: "orphan effort", effort: "easy" },
      ],
      { agents: ["claude", "codex"] },
    );
    expect(plan.tickets.map((t) => [t.agent, t.effort])).toEqual([
      ["codex", "hard"],
      ["claude", undefined],
      [undefined, undefined],
      ["claude", undefined],
      [undefined, undefined],
    ]);
    expect(plan.errors).toEqual([]);
    expect(structural(plan.warnings)).toEqual([
      expect.stringMatching(/ticket 3 is routed to unknown agent "gemini"/),
      expect.stringMatching(/ticket 3 has an effort but no agent/),
      expect.stringMatching(/ticket 4 has unknown effort "medium"/),
      expect.stringMatching(/ticket 5 has an effort but no agent/),
    ]);
  });

  it("does not judge agents when none are configured (a bare dry run)", () => {
    expect(resolvePlan([{ title: "x", agent: "gemini" }]).tickets[0].agent).toBe("gemini");
  });

  it("blocks an over-long brief instead of truncating it", () => {
    expect(resolvePlan([{ title: "x" }], { brief: "a".repeat(MAX_BRIEF_CHARS) }).errors).toEqual([]);
    expect(resolvePlan([{ title: "x" }], { brief: "a".repeat(MAX_BRIEF_CHARS + 1) }).errors).toEqual([
      expect.stringMatching(/plan brief is 4001 characters \(limit 4000\)/),
    ]);
  });
});

describe("definition of done", () => {
  it("parses acceptance and outOfScope as string arrays and rejects anything else", () => {
    const [t] = parseTickets('[{"title":"x","acceptance":["a test passes"],"outOfScope":["polish"]}]');
    expect(t).toMatchObject({ acceptance: ["a test passes"], outOfScope: ["polish"] });
    expect(() => parseTickets('[{"title":"x","acceptance":"a test passes","outOfScope":[1]}]')).toThrow(
      /ticket 1: acceptance must be an array of strings; ticket 1: outOfScope must be an array of strings/,
    );
  });

  it("carries trimmed items and drops empty ones", () => {
    const r = resolvePlan([{ title: "x", acceptance: [" a test passes ", "  "], outOfScope: ["", " polish "] }]);
    expect(r.tickets[0]).toMatchObject({ acceptance: ["a test passes"], outOfScope: ["polish"] });
  });

  it("warns, never blocks, on a ticket with no definition of done", () => {
    const r = resolvePlan([{ title: "Add a flag" }]);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([expect.stringMatching(/ticket 1 has no definition of done/)]);
  });

  it("warns on open-ended wording unless an acceptance item names a check", () => {
    const vague = resolvePlan([{ title: "Model every flow", acceptance: ["covers the main flows well"] }]);
    expect(vague.warnings).toEqual([expect.stringMatching(/ticket 1 reads as open-ended \("every"\)/)]);

    const closed = resolvePlan([{ title: "Model every flow", acceptance: ["a test fails when a step kind has no node"] }]);
    expect(closed.warnings).toEqual([]);

    // Open-ended wording with no acceptance at all earns both warnings.
    expect(resolvePlan([{ title: "A complete model" }]).warnings).toHaveLength(2);
  });

  it("does not flag ordinary wording", () => {
    expect(resolvePlan([{ title: "Add a flag", body: "Parse --yes.", acceptance: ["`--yes` skips the prompt (test)"] }]).warnings).toEqual([]);
  });
});
