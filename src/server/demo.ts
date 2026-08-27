import type { PlanEntry } from "../routing/assign.js";
import type { Ticket } from "../tasks/plan.js";
import { buildPlanMarkers, type PlanCreateResult } from "../tasks/plan-create.js";
import { DEFAULT_CONFIG, type OrchConfig } from "../config.js";
import type { Issue } from "../github/github.js";
import type { ServerDeps } from "./server.js";
import type { Snapshot, TaskView } from "../board/snapshot.js";

/**
 * Self-contained demo backend for `orch serve --demo`.
 *
 * It returns a `ServerDeps` whose functions are backed by an in-memory board
 * instead of GitHub / git / `claude`. The HTTP layer, the loopback guard, and
 * the real `applyPlan` / `selectUnassigned` routing logic are all exercised
 * unchanged — only the I/O boundary is faked — so the demo shows the actual
 * code paths, not a mock-up. `Suggest` returns a canned judge plan; `Apply`
 * mutates this board so the dashboard visibly updates.
 */

const AGENTS = ["claude", "codex"];

interface Suggestion {
  agent: string;
  effort: string;
  rationale: string;
}

/** What the "judge" proposes for each currently-unassigned issue. */
const JUDGE: Record<number, Suggestion> = {
  107: {
    agent: "claude",
    effort: "hard",
    rationale:
      "UI + accessibility work is design-heavy and cross-cutting; claude's recent hard-tier runs landed green (#103), so route the stronger tier to it.",
  },
  108: {
    agent: "codex",
    effort: "easy",
    rationale:
      "A localized read projection over existing snapshot data; codex's lower median cost ($0.31 vs $0.95) makes it the economical pick at the easy tier.",
  },
  109: {
    agent: "codex",
    effort: "hard",
    rationale:
      "Scoring logic threads through the telemetry + dashboard modules codex already owns (#104); route hard to match the ambiguity.",
  },
};

const minutesAgo = (m: number): string => new Date(Date.now() - m * 60_000).toISOString();

/** A fresh, realistic dual-agent board: work in flight, PRs awaiting cross-review, and unrouted todos. */
function seedTasks(): TaskView[] {
  return [
    {
      number: 103,
      title: "Board snapshot projection",
      status: "status:in-review",
      agent: "claude",
      deps: [],
      prNumber: 203,
      reviewedBy: [],
      locked: true,
      worktree: "../wt/issue-103",
      latestRun: { tokensTotal: 71_540, costUsd: 0.95, ts: minutesAgo(6) },
    },
    {
      number: 104,
      title: "Localhost dashboard server",
      status: "status:in-review",
      agent: "codex",
      deps: [],
      prNumber: 204,
      reviewedBy: [],
      locked: true,
      worktree: "../wt/issue-104",
      latestRun: { tokensTotal: 52_110, costUsd: 0.31, ts: minutesAgo(11) },
    },
    {
      number: 105,
      title: "Headless routing judge",
      status: "status:in-progress",
      agent: "claude",
      deps: [],
      prNumber: null,
      reviewedBy: [],
      locked: true,
      worktree: "../wt/issue-105",
      latestRun: { tokensTotal: 63_120, costUsd: 0.84, ts: minutesAgo(2) },
    },
    {
      number: 106,
      title: "Effort → model tiering",
      status: "status:in-progress",
      agent: "codex",
      deps: [],
      prNumber: null,
      reviewedBy: [],
      locked: true,
      worktree: "../wt/issue-106",
      latestRun: { tokensTotal: 41_230, costUsd: 0.25, ts: minutesAgo(4) },
    },
    {
      number: 107,
      title: "Dashboard routing UI",
      status: "status:todo",
      agent: null,
      deps: [],
      prNumber: null,
      reviewedBy: [],
      locked: false,
      worktree: null,
      latestRun: null,
    },
    {
      number: 108,
      title: "Cross-review backlog view",
      status: "status:todo",
      agent: null,
      deps: [103],
      prNumber: null,
      reviewedBy: [],
      locked: false,
      worktree: null,
      latestRun: null,
    },
    {
      number: 109,
      title: "Telemetry-grounded judge scoring",
      status: "status:todo",
      agent: null,
      deps: [],
      prNumber: null,
      reviewedBy: [],
      locked: false,
      worktree: null,
      latestRun: null,
    },
  ];
}

/** Project one in-memory task to the `Issue` shape the routing logic reads. */
function toIssue(task: TaskView): Issue {
  const labels: string[] = [task.status];
  if (task.agent) labels.push(`agent:${task.agent}`);
  for (const reviewer of task.reviewedBy) labels.push(`reviewed-by:${reviewer}`);
  if (task.status === "status:in-review") labels.push("review:needed");
  const body = task.deps.length ? `Depends-on: ${task.deps.map((d) => `#${d}`).join(", ")}` : "";
  return { number: task.number, title: task.title, body, state: "OPEN", labels, assignees: [] };
}

/** Build a `ServerDeps` backed by a fresh in-memory board. */
export function makeDemoDeps(opts: { lifecycleStepMs?: number } = {}): ServerDeps {
  const tasks = seedTasks();
  const createdByMarker = new Map<string, number>();
  const config: OrchConfig = { ...DEFAULT_CONFIG, agents: [...AGENTS] };
  // Longer than the dashboard's 2s poll so each simulated state is visible.
  const lifecycleStepMs = opts.lifecycleStepMs ?? 2_500;

  const reviewQueue = (): number[] =>
    tasks
      .filter((task) => task.status === "status:in-review" && task.prNumber !== null)
      .map((task) => task.prNumber as number)
      .sort((a, b) => a - b);

  return {
    loadConfig: () => config,
    listOpenIssues: async () => tasks.map(toIssue),
    readRuns: () => [],
    runJudge: async () =>
      tasks
        .filter((task) => !task.agent && task.status === "status:todo")
        .map<PlanEntry>((task) => ({
          issue: task.number,
          ...(JUDGE[task.number] ?? { agent: "codex", effort: "easy", rationale: "routed by the judge" }),
        })),
    editIssue: async (n, labels) => {
      const agent = labels.map((l) => /^agent:(.+)$/.exec(l)?.[1]).find(Boolean);
      const task = tasks.find((t) => t.number === n);
      if (task && agent) task.agent = agent;
    },
    createIssues: async (tickets: Ticket[]): Promise<PlanCreateResult> => {
      const result: PlanCreateResult = { created: [], reused: [], failed: [] };
      const idToNumber = new Map<string, number>();
      const markers = buildPlanMarkers(tickets);
      let next = Math.max(0, ...tasks.map((t) => t.number)) + 1;
      for (let index = 0; index < tickets.length; index++) {
        const t = tickets[index];
        const prior = createdByMarker.get(markers.tickets[index]);
        if (prior !== undefined) {
          result.reused.push({ id: t.id, number: prior, title: t.title });
          if (t.id) idToNumber.set(t.id, prior);
          continue;
        }
        const number = next++;
        const deps = (t.dependsOn ?? [])
          .map((d) => idToNumber.get(d))
          .filter((n): n is number => n !== undefined);
        tasks.push({
          number,
          title: t.title,
          status: "status:todo",
          agent: null,
          deps,
          prNumber: null,
          reviewedBy: [],
          locked: false,
          worktree: null,
          latestRun: null,
        });
        createdByMarker.set(markers.tickets[index], number);
        if (t.id) idToNumber.set(t.id, number);
        result.created.push({ id: t.id, number, title: t.title });
      }
      return result;
    },
    snapshot: async (): Promise<Snapshot> => ({
      generatedAt: new Date().toISOString(),
      tasks: tasks.map((task) => ({
        ...task,
        deps: [...task.deps],
        reviewedBy: [...task.reviewedBy],
        latestRun: task.latestRun ? { ...task.latestRun } : null,
      })),
      reviewQueue: reviewQueue(),
    }),
    dispatchIssue: async (number): Promise<void> => {
      const task = tasks.find((candidate) => candidate.number === number);
      if (!task) throw new Error(`#${number} is not an open issue.`);
      if (task.status !== "status:todo") throw new Error(`#${number} is ${task.status}, not a todo.`);
      if (!task.agent) throw new Error(`#${number} is not routed to an agent.`);
      const blockers = task.deps.filter((dep) => tasks.some((candidate) => candidate.number === dep));
      if (blockers.length) {
        throw new Error(`#${number} is blocked by open issue(s): ${blockers.map((dep) => `#${dep}`).join(", ")}.`);
      }

      task.status = "status:claimed";
      task.locked = true;
      task.worktree = `../wt/issue-${number}`;

      const working = setTimeout(() => {
        if (task.status === "status:claimed") task.status = "status:in-progress";
      }, lifecycleStepMs);
      working.unref();

      const submitted = setTimeout(() => {
        if (task.status !== "status:in-progress") return;
        task.status = "status:in-review";
        task.prNumber = Math.max(200, ...tasks.map((candidate) => candidate.prNumber ?? 0)) + 1;
        task.latestRun = {
          tokensTotal: task.agent === "claude" ? 58_400 : 43_700,
          costUsd: task.agent === "claude" ? 0.78 : 0.29,
          ts: new Date().toISOString(),
        };
      }, lifecycleStepMs * 2);
      submitted.unref();
    },
  };
}
