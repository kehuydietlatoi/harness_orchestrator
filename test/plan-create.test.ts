import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { Issue } from "../src/github/github.js";
import type { Ticket } from "../src/tasks/plan.js";
import {
  buildPlanMarkers,
  createFromPlan,
  creationLabels,
  neutralizeReferences,
  renderPlanContext,
  renderTicketBody,
  type PlanCreateDeps,
} from "../src/tasks/plan-create.js";
import { parseAfter, parseDeps } from "../src/board/board.js";

const CWD = "/repo";
const tickets: Ticket[] = [
  { id: "a", title: "First", body: "one" },
  { id: "b", title: "Second", body: "two", dependsOn: ["a"] },
  { id: "c", title: "Third", body: "three", dependsOn: ["b"] },
];

type Fault = { title: string; phase: "before" | "response-loss"; fired: boolean };

function issue(number: number, title: string, body: string): Issue {
  return { number, title, body, state: "OPEN", labels: ["status:todo"], assignees: [] };
}

function harness(initial: Issue[] = [], fault?: Fault) {
  const issues = [...initial];
  const creates: Array<{ title: string; body: string }> = [];
  let next = Math.max(0, ...issues.map((item) => item.number)) + 1;
  const deps: PlanCreateDeps = {
    listIssues: async (opts) => {
      expect(opts).toEqual({ cwd: CWD, state: "all" });
      return [...issues];
    },
    createIssue: async (title, body) => {
      creates.push({ title, body });
      if (fault && !fault.fired && fault.title === title && fault.phase === "before") {
        fault.fired = true;
        throw new Error(`interrupted before ${title}`);
      }
      const number = next++;
      issues.push(issue(number, title, body));
      if (fault && !fault.fired && fault.title === title && fault.phase === "response-loss") {
        fault.fired = true;
        throw new Error(`response lost after ${title}`);
      }
      return number;
    },
  };
  return { issues, creates, deps };
}

function expectExactlyOneIssuePerTicket(issues: Issue[]): void {
  const markers = buildPlanMarkers(tickets);
  for (const marker of markers.tickets) {
    expect(issues.filter((item) => item.body.includes(marker)), marker).toHaveLength(1);
  }
}

function committedPrefix(count: number): Issue[] {
  const markers = buildPlanMarkers(tickets);
  const idToNumber = new Map<string, number>();
  return tickets.slice(0, count).map((ticket, index) => {
    const number = 41 + index;
    const depNumbers = (ticket.dependsOn ?? [])
      .map((id) => idToNumber.get(id))
      .filter((dependency): dependency is number => dependency !== undefined);
    const body = renderTicketBody(ticket, depNumbers, {
      plan: markers.plan,
      ticket: markers.tickets[index],
    });
    if (ticket.id) idToNumber.set(ticket.id, number);
    return issue(number, ticket.title, body);
  });
}

describe("plan markers", () => {
  it("preserves the legacy v1 digest for omitted/empty after and distinguishes advisory changes", () => {
    const legacy = tickets.map((t) => ({
      id: t.id ?? null, title: t.title, body: (t.body ?? "").trim(), dependsOn: t.dependsOn ?? [], files: t.files ?? [],
    }));
    const hash = createHash("sha256").update(JSON.stringify(legacy)).digest("hex");
    const original = buildPlanMarkers(tickets);
    expect(original.plan).toBe(`<!-- orch-plan:v1:${hash} -->`);
    expect(buildPlanMarkers(tickets.map((t) => ({ ...t, after: [] })))).toEqual(original);
    expect(buildPlanMarkers([tickets[0], { ...tickets[1], after: ["a"] }, tickets[2]])).not.toEqual(original);
  });
  it("are deterministic for semantically equivalent ticket input", () => {
    const explicitEmpty: Ticket[] = [
      { id: "a", title: "First", body: "  one  ", dependsOn: [], files: [] },
      { id: "b", title: "Second", body: "two", dependsOn: ["a"], files: [] },
      { id: "c", title: "Third", body: "three", dependsOn: ["b"], files: [] },
    ];

    expect(buildPlanMarkers(explicitEmpty)).toEqual(buildPlanMarkers(tickets));
    expect(buildPlanMarkers(tickets).plan).toMatch(/^<!-- orch-plan:v1:[a-f0-9]{64} -->$/);
    for (const marker of buildPlanMarkers(tickets).tickets) {
      expect(marker).toMatch(/^<!-- orch-ticket:v1:[a-f0-9]{64} -->$/);
    }
  });

  it("renders both stable markers after the human-readable body", () => {
    const markers = buildPlanMarkers(tickets);
    const body = renderTicketBody(tickets[1], [42], { plan: markers.plan, ticket: markers.tickets[1] });

    expect(body).toContain("Depends-on: #42");
    expect(body).toContain(markers.plan);
    expect(body).toContain(markers.tickets[1]);
  });
});

describe("createFromPlan recovery", () => {
  it.each(["before", "response-loss"] as const)("preserves advisory links after %s and retry creates no duplicates", async (phase) => {
    const advisory: Ticket[] = [
      { id: "a", title: "First" },
      { id: "b", title: "Second", after: ["a"] },
      { id: "c", title: "Third", dependsOn: ["a"], after: ["b"] },
    ];
    const h = harness([], { title: "First", phase, fired: false });
    const first = await createFromPlan(advisory, CWD, h.deps);
    if (phase === "before") {
      expect(first.failed.map((f) => f.title)).toEqual(["First", "Second", "Third"]);
      expect(first.failed[1].error).toMatch(/advisory ticket.*unavailable/);
    }
    const retry = await createFromPlan(advisory, CWD, h.deps);
    expect(retry.failed).toEqual([]);
    expect(h.issues).toHaveLength(3);
    expect(h.issues.find((i) => i.title === "Second")?.body).toContain("After: #1");
    expect(h.issues.find((i) => i.title === "Second")?.body).not.toContain("Depends-on:");
    expect(h.issues.find((i) => i.title === "Third")?.body).toContain("Depends-on: #1\n\nAfter: #2");
    expect(await createFromPlan(advisory, CWD, h.deps)).toMatchObject({ created: [], failed: [] });
    expect(h.issues).toHaveLength(3);
  });

  it("renders a reused closed predecessor's number as an advisory reference", async () => {
    const advisory = [{ id: "a", title: "First" }, { title: "Second", after: ["a"] }];
    const markers = buildPlanMarkers(advisory);
    const first = issue(42, "First", renderTicketBody(advisory[0], [], { plan: markers.plan, ticket: markers.tickets[0] }));
    first.state = "CLOSED";
    const h = harness([first]);
    expect((await createFromPlan(advisory, CWD, h.deps)).failed).toEqual([]);
    expect(h.creates[0].body).toContain("After: #42");
  });
  it.each([1, 2, 3])(
    "resumes a process interrupted after create call %i",
    async (completedCount) => {
      const h = harness(committedPrefix(completedCount));

      const result = await createFromPlan(tickets, CWD, h.deps);

      expect(result.failed).toEqual([]);
      expect(result.reused).toHaveLength(completedCount);
      expect(result.created).toHaveLength(tickets.length - completedCount);
      expectExactlyOneIssuePerTicket(h.issues);
    },
  );

  it.each(tickets.map((ticket) => [ticket.title]))(
    "rolls forward after interruption before the create for %s",
    async (title) => {
      const fault: Fault = { title, phase: "before", fired: false };
      const h = harness([], fault);

      const interrupted = await createFromPlan(tickets, CWD, h.deps);
      expect(interrupted.failed.length).toBeGreaterThan(0);

      const retried = await createFromPlan(tickets, CWD, h.deps);
      expect(retried.failed).toEqual([]);
      expectExactlyOneIssuePerTicket(h.issues);
    },
  );

  it.each(tickets.map((ticket) => [ticket.title]))(
    "reconciles response loss after the create for %s and retry stays idempotent",
    async (title) => {
      const fault: Fault = { title, phase: "response-loss", fired: false };
      const h = harness([], fault);

      const interrupted = await createFromPlan(tickets, CWD, h.deps);
      expect(interrupted.failed).toEqual([]);
      expect(interrupted.reused.map((item) => item.title)).toContain(title);

      const retried = await createFromPlan(tickets, CWD, h.deps);
      expect(retried).toMatchObject({ created: [], failed: [] });
      expect(retried.reused).toHaveLength(tickets.length);
      expectExactlyOneIssuePerTicket(h.issues);
    },
  );

  it("uses a reused ticket number when rendering a new dependent ticket", async () => {
    const markers = buildPlanMarkers(tickets);
    const first = issue(
      42,
      tickets[0].title,
      renderTicketBody(tickets[0], [], { plan: markers.plan, ticket: markers.tickets[0] }),
    );
    const h = harness([first]);

    const result = await createFromPlan(tickets, CWD, h.deps);

    expect(result.reused).toEqual([{ id: "a", number: 42, title: "First" }]);
    expect(h.creates.find((call) => call.title === "Second")?.body).toContain("Depends-on: #42");
    expectExactlyOneIssuePerTicket(h.issues);
  });

  it("fails closed without writes when initial discovery fails", async () => {
    let creates = 0;
    const deps: PlanCreateDeps = {
      listIssues: async () => {
        throw new Error("GitHub unavailable");
      },
      createIssue: async () => {
        creates++;
        return 1;
      },
    };

    const result = await createFromPlan(tickets, CWD, deps);

    expect(result.created).toEqual([]);
    expect(result.reused).toEqual([]);
    expect(result.failed).toHaveLength(tickets.length);
    expect(result.failed[0].error).toMatch(/discovery failed.*GitHub unavailable/);
    expect(creates).toBe(0);
  });

  it("reports duplicate marker matches instead of choosing one or creating another", async () => {
    const markers = buildPlanMarkers([tickets[0]]);
    const body = renderTicketBody(tickets[0], [], { plan: markers.plan, ticket: markers.tickets[0] });
    const h = harness([issue(7, "First", body), issue(9, "First copy", body)]);

    const result = await createFromPlan([tickets[0]], CWD, h.deps);

    expect(result.failed[0].error).toContain("#7, #9");
    expect(h.creates).toEqual([]);
  });
});

describe("plan brief and routing at creation", () => {
  const routed: Ticket[] = [
    { id: "a", title: "First", body: "one", agent: "codex", effort: "hard" },
    { id: "b", title: "Second", body: "two", dependsOn: ["a"], agent: "claude" },
    { id: "c", title: "Third", body: "three", dependsOn: ["b"] },
  ];
  const brief = "## Goal\nShip SSO.\n\nThis depends on #12 and #13 landing first.\nAfter: #14\n";

  function routingHarness(initial: Issue[] = [], ensureError?: Error) {
    const issues = [...initial];
    const creates: Array<{ title: string; body: string; labels: string[] }> = [];
    const ensured: string[][] = [];
    let next = Math.max(0, ...issues.map((item) => item.number)) + 1;
    const deps: PlanCreateDeps = {
      listIssues: async () => [...issues],
      createIssue: async (title, body, labels) => {
        creates.push({ title, body, labels });
        const number = next++;
        issues.push({ ...issue(number, title, body), labels });
        return number;
      },
      ensureLabels: async (labels) => {
        ensured.push(labels.map((l) => l.name));
        if (ensureError) throw ensureError;
      },
    };
    return { issues, creates, ensured, deps };
  }

  it("keeps plan identity independent of routing and the brief", () => {
    expect(buildPlanMarkers(routed)).toEqual(
      buildPlanMarkers(routed.map(({ agent: _agent, effort: _effort, ...rest }) => rest)),
    );
  });

  it("creates routed issues with agent/effort labels after ensuring exactly those labels exist", async () => {
    const h = routingHarness();
    const result = await createFromPlan(routed, CWD, h.deps, { agents: ["claude", "codex"], brief });

    expect(result.failed).toEqual([]);
    expect(h.ensured).toEqual([["agent:codex", "effort:hard", "agent:claude"]]);
    expect(h.creates.map((c) => c.labels)).toEqual([
      ["status:todo", "agent:codex", "effort:hard"],
      ["status:todo", "agent:claude"],
      ["status:todo"],
    ]);
  });

  it("drops routing to an unconfigured agent, creating that issue unrouted", async () => {
    const h = routingHarness();
    await createFromPlan([{ title: "x", agent: "gemini", effort: "easy" }], CWD, h.deps, { agents: ["claude"] });
    expect(h.creates[0].labels).toEqual(["status:todo"]);
    expect(h.ensured).toEqual([]);
  });

  it("embeds the brief as collapsed plan context whose references never become dependencies", async () => {
    const h = routingHarness();
    await createFromPlan(routed, CWD, h.deps, { agents: ["claude", "codex"], brief });

    const second = h.creates[1].body;
    expect(second).toContain("<details>\n<summary>Plan context</summary>");
    expect(second).toContain("Ship SSO.");
    expect(second).toContain("depends on issue 12 and #13"); // "and" ends a parseable reference list
    expect(second).toContain("After: issue 14");
    expect(parseDeps(second)).toEqual([1]);
    expect(parseAfter(second)).toEqual([]);
    // The context sits before the identity markers.
    expect(second.indexOf("Plan context")).toBeLessThan(second.indexOf("<!-- orch-plan:"));
  });

  it("never relabels or rewrites a reused issue, and ensures only labels still needed", async () => {
    const markers = buildPlanMarkers(routed);
    const first = issue(42, "First", renderTicketBody(routed[0], [], { plan: markers.plan, ticket: markers.tickets[0] }));
    const h = routingHarness([first]);

    const result = await createFromPlan(routed, CWD, h.deps, { agents: ["claude", "codex"], brief });

    expect(result.reused).toEqual([{ id: "a", number: 42, title: "First" }]);
    expect(h.ensured).toEqual([["agent:claude"]]);
    expect(h.creates.map((c) => c.title)).toEqual(["Second", "Third"]);
    expect(h.issues.find((i) => i.number === 42)?.labels).toEqual(["status:todo"]);
  });

  it("fails closed without writes when routing labels cannot be ensured", async () => {
    const h = routingHarness([], new Error("label API down"));
    const result = await createFromPlan(routed, CWD, h.deps, { agents: ["claude", "codex"] });
    expect(h.creates).toEqual([]);
    expect(result.failed).toHaveLength(3);
    expect(result.failed[0].error).toMatch(/could not ensure routing labels: label API down/);
  });

  it("refuses an over-long brief before any read or write", async () => {
    const h = routingHarness();
    await expect(createFromPlan(routed, CWD, h.deps, { brief: "x".repeat(4001) })).rejects.toThrow(/plan brief/);
    expect(h.creates).toEqual([]);
  });

  it("renders nothing extra without a brief and neutralizes only parseable references", () => {
    expect(renderPlanContext(undefined)).toBe("");
    expect(renderPlanContext("   ")).toBe("");
    expect(neutralizeReferences("see #5; Depends-on: #6, #7\n  after: #8\nfinish after #9")).toBe(
      "see #5; Depends-on: issue 6, issue 7\n  after: issue 8\nfinish after #9",
    );
    expect(creationLabels({ effort: "hard" })).toEqual(["status:todo"]);
  });
});
