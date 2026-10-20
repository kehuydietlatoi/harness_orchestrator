import { describe, it, expect } from "vitest";
import { MAX_BRIEF_CHARS, parseTickets, resolvePlan } from "../src/tasks/plan.js";
import { renderTicketBody } from "../src/tasks/plan-create.js";
import { DEFAULT_CONFIG } from "../src/config.js";

describe("needs and sensitivity planning", () => {
  it("permits vision on Claude and Codex, refusing web everywhere", () => {
    expect(resolvePlan([{ title: "See", agent: "claude", needs: ["vision"] }], { config: DEFAULT_CONFIG }).errors).toEqual([]);
    expect(resolvePlan([{ id: "see", title: "See", agent: "codex", needs: ["vision"] }], { config: DEFAULT_CONFIG }).errors).toEqual([]);
    expect(resolvePlan([{ title: "Search", needs: ["web"] }], { config: DEFAULT_CONFIG }).errors.join()).toMatch(/no satisfying.*web/);
  });
  it.each(["engine", "image-gen", "audio-gen"] as const)("defers %s to Phases 3-4", need => {
    expect(resolvePlan([{ title: "Future", needs: [need] }]).errors.join()).toContain("Phases 3-4");
  });
  it("finds a capable later member but rejects an explicit incapable selection", () => {
    const config = { ...DEFAULT_CONFIG, tierMembers: { free: [], cheap: [], standard: [], lead: [{ agent: "codex", model: "a", capabilities: ["shell"] }, { agent: "codex", model: "b", capabilities: ["vision"] }] } };
    expect(resolvePlan([{ title: "See", needs: ["vision"] }], { config }).errors).toEqual([]);
    expect(resolvePlan([{ title: "See", agent: "codex", effort: "lead", model: "a", needs: ["vision"] }], { config }).errors.join()).toContain("no satisfying");
    expect(resolvePlan([{ title: "See", agent: "codex", effort: "lead", model: "b", needs: ["vision"] }], { config }).errors).toEqual([]);
  });
});

describe("ticket verify trust", () => {
  const config = { ...DEFAULT_CONFIG, verify: [["node", "--test"]] };
  it("accepts only project prefixes plus paths, separators and plain numbers", () => {
    expect(resolvePlan([{ id: "checks", title: "Check", verify: [["node", "--test", "--", "tests/a.test.ts", "3"]] }], { config }).errors).toEqual([]);
  });
  it.each(["-e", "--require", "..", "../escape", "tests/../escape", "/etc/passwd", "C:\\tests\\a.ts", "\\\\host\\share", "tests/a\0.ts"])("rejects argument %j with the ticket identity", (arg) => {
    const errors = resolvePlan([{ id: "checks", title: "Check", verify: [["node", "--test", arg]] }], { config }).errors;
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('ticket 1 ("checks")');
    expect(errors[0]).toContain(JSON.stringify(arg));
  });
  it("rejects unrelated executables and changes within the prefix", () => {
    for (const argv of [["python", "tests/check.py"], ["node", "-e", "code"]]) {
      expect(resolvePlan([{ id: "checks", title: "Check", verify: [argv] }], { config }).errors[0])
        .toContain(JSON.stringify(argv[argv[0] === "node" ? 1 : 0]));
    }
    expect(resolvePlan([{ title: "Check", verify: [["node", "--test"]] }]).errors).toHaveLength(1);
  });
});

describe("exclusive plan locks", () => {
  it.each([["scenes/main.scene", "scenes/main.scene"], ["assets/**", "assets/hero.png"], ["assets/*/hero.png", "assets/characters/*.png"]])(
    "rejects independent tickets sharing %s / %s", (left, right) => {
      const result = resolvePlan([{ id: "first", title: "a", locks: [left] }, { id: "second", title: "b", locks: [right] }]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatch(/first.*second.*locks overlap/);
    });

  it("allows sharing through transitive hard dependencies, but not after preferences", () => {
    const a = { id: "a", title: "a", locks: ["scenes/**"] };
    const b = { id: "b", title: "b", dependsOn: ["a"] };
    const c = { id: "c", title: "c", locks: ["scenes/main.scene"], dependsOn: ["b"] };
    expect(resolvePlan([a, b, c]).errors).toEqual([]);
    expect(resolvePlan([a, { ...c, dependsOn: [], after: ["a"] }]).errors.join(" ")).toMatch(/a.*c.*locks overlap/);
  });

  it("requires nonempty asset locks in parse and resolve and rejects escaping paths", () => {
    for (const locks of [undefined, []]) {
      const ticket = { id: "hero", title: "hero", kind: "asset" as const, locks };
      expect(() => parseTickets(JSON.stringify([ticket]))).toThrow(/hero.*locks.*asset/);
      expect(resolvePlan([ticket]).errors.join(" ")).toMatch(/hero.*locks.*asset/);
    }
    expect(resolvePlan([{ title: "bad", locks: ["../outside"] }]).errors.join(" ")).toMatch(/locks.*repository-relative/);
    expect(resolvePlan([{ title: "hero", kind: "asset", locks: ["assets/hero.png"] }]).errors).toEqual([]);
  });
});

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
    expect(r.errors).toEqual(['ticket 1 ("a"): title needs a title', 'ticket 2 ("a"): id duplicate id "a"']);
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
    const [t] = parseTickets('[{"title":"x","agent":"codex","effort":"lead"}]');
    expect(t).toMatchObject({ agent: "codex", effort: "lead" });
    expect(() => parseTickets('[{"title":"x","agent":1,"effort":["lead"]}]')).toThrow(
      /ticket 1: agent must be a string; ticket 1: effort must be a string/,
    );
  });

  it("keeps valid routing and drops unknown agents, unknown efforts, and an effort without an agent", () => {
    const plan = resolvePlan(
      [
        { title: "ok", agent: "codex", effort: "lead" },
        { title: "agent only", agent: "claude" },
        { title: "stranger", agent: "gemini", effort: "standard" },
        { title: "bad tier", agent: "claude", effort: "medium" },
        { title: "orphan effort", effort: "standard" },
      ],
      { agents: ["claude", "codex"] },
    );
    expect(plan.tickets.map((t) => [t.agent, t.effort])).toEqual([
      ["codex", "lead"],
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

it.each([
  ["free", "free"], ["cheap", "cheap"], ["standard", "standard"], ["lead", "lead"],
  ["easy", "standard"], ["hard", "lead"],
])("accepts and normalizes plan effort %s to %s", (effort, expected) => {
  const plan = resolvePlan([{ title: "tier", agent: "codex", effort, acceptance: ["npm test passes"] }]);
  expect(plan.tickets[0].effort).toBe(expected);
  expect(plan.warnings).toEqual([]);
});

it("uses configured tier aliases for legacy plan effort", () => {
  const plan = resolvePlan([{ title: "tier", agent: "codex", effort: "easy" }], { tierAliases: { easy: "free" } });
  expect(plan.tickets[0].effort).toBe("free");
});


describe("v2 structural validation", () => {
  it("reports three independent errors with ticket id and field", () => {
    const plan = resolvePlan([{ id: "T1", title: "Check fields", kind: "bad", needs: ["telepathy"], verify: ["npm test"] }] as any);
    expect(plan.errors).toHaveLength(3);
    for (const field of ["kind", "needs", "verify"]) expect(plan.errors).toContainEqual(expect.stringMatching(new RegExp('T1.*' + field)));
  });

  it("keeps checking later tickets and semantic errors after malformed fields", () => {
    const plan = resolvePlan([{ id: "T1", title: "", files: 2 }, null, { id: "T1", title: "Second", budget: { minutes: -1, requests: 0.5 } }] as any);
    expect(plan.errors.join('; ')).toMatch(/T1.*files/);
    expect(plan.errors.join('; ')).toMatch(/T1.*title/);
    expect(plan.errors.join('; ')).toMatch(/ticket 2.*ticket/);
    expect(plan.errors.join('; ')).toMatch(/T1.*id duplicate/);
    expect(plan.errors.join('; ')).toMatch(/T1.*budget.minutes/);
    expect(plan.errors.join('; ')).toMatch(/T1.*budget.requests/);
  });

  it.each([
    { role: 3 }, { role: "Bad Role" }, { milestone: "" }, { decisions: ["D-1"] },
    { context: ["Not an anchor"] }, { locks: [""] }, { locks: ["a", "a"] },
    { sensitivity: "private" }, { model: [] }, { budget: null }, { budget: { extra: 1 } },
    { budget: { usd: Infinity } }, { verify: "npm test" }, { verify: [] },
    { verify: [[]] }, { verify: [["npm", " "]] }, { verify: [["npm", 1]] },
  ])("rejects malformed v2 fields: %j", (fields) => {
    expect(resolvePlan([{ title: "Valid title", ...fields }] as any).errors.length).toBeGreaterThan(0);
    expect(() => parseTickets(JSON.stringify([{ title: "Valid title", ...fields }]))).toThrow();
  });

  it("preserves argv boundaries and accepts optional empty arrays and zero budgets", () => {
    const fields = { verify: [["node", "path with spaces/check.js", "literal|argument"]], needs: [], locks: [], budget: { minutes: 0, usd: 0, requests: 0 } };
    const [ticket] = parseTickets(JSON.stringify([{ title: "A valid title", ...fields }]));
    expect(resolvePlan([ticket], { config: { ...DEFAULT_CONFIG, verify: [["node"]] } }).errors).toEqual([]);
    expect(resolvePlan([ticket]).tickets[0]).toMatchObject(fields);
  });
});
