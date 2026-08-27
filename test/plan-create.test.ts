import { describe, expect, it } from "vitest";
import type { Issue } from "../src/github/github.js";
import type { Ticket } from "../src/tasks/plan.js";
import {
  buildPlanMarkers,
  createFromPlan,
  renderTicketBody,
  type PlanCreateDeps,
} from "../src/tasks/plan-create.js";

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
