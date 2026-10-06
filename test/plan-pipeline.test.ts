import { describe, expect, it } from "vitest";
import { planGate, runPlanPipeline, type PipelineDeps } from "../src/commands/plan-pipeline.js";
import { parseIssueList } from "../src/commands/autopilot.js";
import { claimableBy } from "../src/board/board.js";
import type { Issue } from "../src/github/github.js";
import type { PlanCreateResult } from "../src/tasks/plan-create.js";
import type { Ticket } from "../src/tasks/plan.js";

const tickets: Ticket[] = [{ id: "a", title: "First" }, { id: "b", title: "Second" }];

function fakeDeps(over: Partial<PipelineDeps> & { created?: PlanCreateResult } = {}) {
  const calls: string[] = [];
  const said: string[] = [];
  const deps: PipelineDeps = {
    create: async (_t, opts) => {
      calls.push(`create:${opts.agents?.join("+")}:${opts.brief ?? ""}`);
      return over.created ?? { created: [{ id: "b", number: 12, title: "Second" }], reused: [{ id: "a", number: 11, title: "First" }], failed: [] };
    },
    report: () => calls.push("report"),
    route: async (only) => {
      calls.push(`route:${[...only].join(",")}`);
      return { unrouted: 1, written: 1 };
    },
    autopilot: async (issues) => { calls.push(`autopilot:${issues.join(",")}`); },
    say: (line) => said.push(line),
    ...over,
  };
  return { deps, calls, said };
}

describe("planGate", () => {
  it("runs on --yes, asks in an interactive terminal session, and otherwise only hints", () => {
    expect(planGate({ yes: true, interactive: false, tty: false })).toBe("run");
    expect(planGate({ yes: true, interactive: true, tty: true })).toBe("run");
    expect(planGate({ interactive: true, tty: true })).toBe("ask");
    expect(planGate({ interactive: true, tty: false })).toBe("hint");
    expect(planGate({ interactive: false, tty: true })).toBe("hint");
  });
});

describe("runPlanPipeline", () => {
  it("creates, routes only the plan's issues, then runs an autopilot scoped to them", async () => {
    const { deps, calls, said } = fakeDeps();
    const result = await runPlanPipeline({ tickets, brief: "why", agents: ["claude", "codex"], run: true }, deps);

    expect(result).toEqual({ issues: [11, 12], stage: "ran" });
    expect(calls).toEqual(["create:claude+codex:why", "report", "route:11,12", "autopilot:11,12"]);
    expect(said.join("\n")).toContain("resume with: orch autopilot --issues 11,12");
  });

  it("stops before routing when any issue could not be created", async () => {
    const { deps, calls } = fakeDeps({
      created: { created: [{ number: 11, title: "First" }], reused: [], failed: [{ title: "Second", error: "boom" }] },
    });
    const result = await runPlanPipeline({ tickets, agents: ["claude"], run: true }, deps);

    expect(result.stage).toBe("create-failed");
    expect(calls).toEqual(["create:claude:", "report"]);
  });

  it("starts nothing when the judge fails, and says how to resume", async () => {
    const { deps, calls, said } = fakeDeps({ route: async () => { throw new Error("judge timed out"); } });
    const result = await runPlanPipeline({ tickets, agents: ["claude"], run: true }, deps);

    expect(result.stage).toBe("route-failed");
    expect(calls).not.toContain("autopilot:11,12");
    expect(said.join("\n")).toMatch(/judge timed out[\s\S]*orch assign --auto[\s\S]*orch autopilot --issues 11,12/);
  });

  it("stops after routing with --no-run", async () => {
    const { deps, calls, said } = fakeDeps();
    const result = await runPlanPipeline({ tickets, agents: ["claude"], run: false }, deps);

    expect(result.stage).toBe("routed");
    expect(calls.some((c) => c.startsWith("autopilot"))).toBe(false);
    expect(said.join("\n")).toContain("Start with: orch autopilot --issues 11,12");
  });

  it("warns when the judge left some issues unrouted (they are never claimed) but still runs the rest", async () => {
    const { deps, calls, said } = fakeDeps({ route: async () => ({ unrouted: 2, written: 1 }) });
    await runPlanPipeline({ tickets, agents: ["claude"], run: true }, deps);

    expect(said.join("\n")).toMatch(/Routed 1 of 2[\s\S]*never claimed/);
    expect(calls).toContain("autopilot:11,12");
  });

  it("does nothing more for an empty plan", async () => {
    const { deps, calls } = fakeDeps({ created: { created: [], reused: [], failed: [] } });
    expect((await runPlanPipeline({ tickets: [], agents: ["claude"], run: true }, deps)).issues).toEqual([]);
    expect(calls).toEqual(["create:claude:", "report"]);
  });
});

describe("scoping helpers", () => {
  const issue = (number: number, labels: string[]): Issue => ({ number, title: "", body: "", state: "OPEN", labels, assignees: [] });

  it("claimableBy refuses issues outside the scope even when routed to the agent", () => {
    const only = new Set([5]);
    expect(claimableBy(issue(5, ["agent:claude"]), "claude", { requireRouted: true, only })).toBe(true);
    expect(claimableBy(issue(6, ["agent:claude"]), "claude", { requireRouted: true, only })).toBe(false);
    expect(claimableBy(issue(6, ["agent:claude"]), "claude", { requireRouted: true })).toBe(true);
  });

  it("parseIssueList accepts commas, spaces, and # and rejects anything else", () => {
    expect([...parseIssueList("12,13 #14,,")]).toEqual([12, 13, 14]);
    expect(() => parseIssueList("12,abc")).toThrow(/--issues/);
    expect(() => parseIssueList("0")).toThrow(/--issues/);
    expect(() => parseIssueList(" , ")).toThrow(/at least one/);
  });
});
