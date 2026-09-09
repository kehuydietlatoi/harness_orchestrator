import {
  type ChecksState,
  type Issue,
  type Pr,
  getRepoUrl,
  listIssues,
  listPrs,
  prChecksState,
} from "../github/github.js";
import { issueAgent, parseDeps, openDepsFromMap, byNumber } from "./board.js";
import { buildGraph } from "./graph.js";
import { REVIEW_NEEDED, REVIEWED_BY_PREFIX } from "../github/labels.js";
import { listLocks } from "../git/lock.js";
import { prIssueNumber } from "./review.js";
import { readRuns, type RunRecord } from "./telemetry.js";
import { exec } from "../util/exec.js";
import type { Worktree } from "../git/worktree.js";
import { compareBranchToBase, resolveBaseBranch } from "../git/git.js";
import { loadConfig } from "../config.js";
import { deriveTaskState, type TaskFacts, type TaskState } from "../tasks/lifecycle.js";
import { prFact, telemetryFact } from "../tasks/facts.js";
import { existsSync } from "node:fs";

export interface TaskView {
  number: number;
  title: string;
  status: string;
  health: TaskState;
  recoveryCommand: string | null;
  issueState: string;
  blockers: number[];
  agent: string | null;
  deps: number[];
  prNumber: number | null;
  /** Canonical GitHub web URL for the PR, or null when there is no PR / no URL. */
  prUrl: string | null;
  /** CI roll-up for the PR (review-queue PRs only; null otherwise or when unknown). */
  prChecks: ChecksState | null;
  reviewedBy: string[];
  locked: boolean;
  worktree: string | null;
  latestRun: {
    tokensTotal: number | null;
    costUsd: number | null;
    ts: string;
    /** Resolved model/effort tier the run used, or null when unknown. */
    model: string | null;
  } | null;
}

export interface Snapshot {
  generatedAt: string;
  tasks: TaskView[];
  /** Open PR numbers currently carrying the review-needed label. */
  reviewQueue: number[];
  /** Deadlocked dependency groups; each `[a, b, c]` means a→b→c→a. Empty when acyclic. */
  cycles: number[][];
  /** Repository web URL (e.g. `https://github.com/owner/repo`) for building
   * issue/PR links, or null when it can't be resolved. */
  repoUrl: string | null;
}

export type SnapshotRun = Pick<RunRecord, "issue" | "tokensTotal" | "costUsd" | "ts" | "model"> & Partial<Pick<RunRecord, "outcome">>;
export type BranchObservation = { state: TaskFacts["branch"]; error?: string };

export function healthStatus(health: TaskState): string {
  return health.kind === "ready" ? "status:todo" : `status:${health.kind}`;
}

export function healthDetail(task: TaskView): string {
  const health = task.health;
  const detail = health.kind === "inconsistent" ? health.violations.map((v) => v.detail).join("; ")
    : health.kind === "needs-attention" ? health.reason : "";
  return [detail, task.recoveryCommand].filter(Boolean).join(" — ");
}

function worktreeIssueNumber(worktree: Worktree): number | null {
  const byPath = worktree.path.match(/[\\/]issue-(\d+)[\\/]?$/);
  if (byPath) return Number(byPath[1]);
  const branch = worktree.branch.replace(/^refs\/heads\//, "");
  const byBranch = branch.match(/^task\/(\d+)(?:-|$)/);
  if (byBranch) return Number(byBranch[1]);

  return null;
}

/**
 * Pure board projection. Callers may supply `generatedAt` to make the result
 * fully deterministic; the default keeps the helper convenient for consumers.
 */
export function assemble(
  issues: readonly Issue[],
  prs: readonly Pr[],
  locks: readonly number[],
  worktrees: readonly Worktree[],
  runs: readonly SnapshotRun[],
  generatedAt = new Date().toISOString(),
  repoUrl: string | null = null,
  checks: ReadonlyMap<number, ChecksState> = new Map(),
  branches: ReadonlyMap<number, BranchObservation> = new Map(),
): Snapshot {
  const locked = new Set(locks);

  const prByIssue = new Map<number, Pr>();
  for (const pr of prs) {
    const issue = prIssueNumber(pr);
    if (issue !== null && (!prByIssue.has(issue) || pr.state === "OPEN")) prByIssue.set(issue, pr);
  }

  const worktreeByIssue = new Map<number, string>();
  for (const worktree of worktrees) {
    const issue = worktreeIssueNumber(worktree);
    if (issue !== null) worktreeByIssue.set(issue, worktree.path);
  }

  const latestRunByIssue = new Map<number, SnapshotRun>();
  for (const run of runs) latestRunByIssue.set(run.issue, run);

  const issueMap = new Map(issues.map((i) => [i.number, i]));
  const numbers = new Set([...issues.filter((i) => i.state === "OPEN").map((i) => i.number),
    ...locks, ...worktreeByIssue.keys(), ...branches.keys()]);
  const sortedIssues = [...numbers].sort((a, b) => a - b).map((number): Issue => issueMap.get(number) ?? {
    number, title: "Missing or inaccessible issue", body: "", state: "MISSING", labels: [], assignees: [],
  }).filter((i) => i.state !== "CLOSED" || locked.has(i.number) || worktreeByIssue.has(i.number));
  const open = byNumber(issues.filter((i) => i.state === "OPEN"));
  const tasks = sortedIssues.map((issue): TaskView => {
    const pr = prByIssue.get(issue.number);
    const run = latestRunByIssue.get(issue.number);
    const branch = branches.get(issue.number);
    const relatedWorktrees = worktrees.filter((w) => worktreeIssueNumber(w) === issue.number);
    const health = deriveTaskState({
      issue: issue.state === "OPEN" ? "open" : issue.state === "CLOSED" ? "closed" : "missing",
      lock: locked.has(issue.number), worktree: relatedWorktrees.length > 0,
      branch: branch?.state ?? "absent",
      pr: prFact(prs.filter((p) => prIssueNumber(p) === issue.number)),
      telemetry: telemetryFact(runs, issue.number),
    });
    const errors = [branch?.error,
      relatedWorktrees.some((w) => !w.branch) ? "task worktree is detached" : undefined,
      relatedWorktrees.some((w) => w.branch && !new RegExp(`^(?:refs/heads/)?task/${issue.number}(?:-|$)`).test(w.branch)) ? "worktree is on an unexpected branch" : undefined,
      relatedWorktrees.length > 1 ? "multiple worktrees map to this issue" : undefined].filter((e): e is string => !!e);
    const observedHealth: TaskState = errors.length ? { kind: "inconsistent", recovery: "reconcile-facts",
      violations: [...(health.kind === "inconsistent" ? health.violations : []),
        ...errors.map((detail) => ({ invariant: "unrecognized-fact-combination" as const, detail }))] } : health;
    return {
      number: issue.number,
      title: issue.title,
      status: healthStatus(observedHealth),
      health: observedHealth,
      recoveryCommand: ["inconsistent", "needs-attention"].includes(observedHealth.kind) ? `orch repair ${issue.number}` : null,
      issueState: issue.state,
      blockers: openDepsFromMap(issue, open),
      agent: issueAgent(issue),
      deps: parseDeps(issue.body),
      prNumber: pr?.number ?? null,
      prUrl: pr?.htmlUrl || null,
      prChecks: pr ? (checks.get(pr.number) ?? null) : null,
      reviewedBy: issue.labels
        .filter((label) => label.startsWith(REVIEWED_BY_PREFIX))
        .map((label) => label.slice(REVIEWED_BY_PREFIX.length)),
      locked: locked.has(issue.number),
      worktree: worktreeByIssue.get(issue.number) ?? null,
      latestRun: run
        ? {
            tokensTotal: run.tokensTotal,
            costUsd: run.costUsd,
            ts: run.ts,
            model: run.model ?? null,
          }
        : null,
    };
  });

  const issueByNumber = new Map(sortedIssues.map((issue) => [issue.number, issue]));
  const reviewQueue = prs
    .filter((pr) => {
      const issueNumber = prIssueNumber(pr);
      return pr.state === "OPEN" && issueNumber !== null && issueByNumber.get(issueNumber)?.labels.includes(REVIEW_NEEDED);
    })
    .map((pr) => pr.number)
    .sort((a, b) => a - b);

  const { cycles } = buildGraph(issues.filter((i) => i.state === "OPEN"));

  return { generatedAt, tasks, reviewQueue, cycles, repoUrl };
}

function parseWorktrees(text: string): Worktree[] {
  const worktrees: Worktree[] = [];
  let path: string | null = null;
  let branch = "";

  const flush = (): void => {
    if (path !== null) worktrees.push({ path, branch });
    path = null;
    branch = "";
  };

  for (const line of text.split(/\r?\n/)) {
    if (line === "") {
      flush();
    } else if (line.startsWith("worktree ")) {
      path = line.slice("worktree ".length);
    } else if (line.startsWith("branch ")) {
      branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    }
  }
  flush();
  return worktrees;
}

async function listWorktrees(cwd: string): Promise<Worktree[]> {
  const result = await exec("git", ["worktree", "list", "--porcelain"], { cwd });
  if (result.code !== 0) throw new Error(`cannot observe worktrees: ${result.stderr.trim()}`);
  return parseWorktrees(result.stdout);
}

/** Cache of CI state keyed by `<pr>:<headSha>` so steady-state polls reuse a
 * result until a new commit lands, rather than shelling out to `gh` every 2s. */
const checksCache = new Map<string, { state: ChecksState; expires: number }>();

/** CI roll-up for the PRs whose issue is awaiting review — the only ones the
 * dashboard renders a checks badge for. Cached by head SHA; unknown SHAs are
 * fetched once and reused until the branch advances. */
async function reviewChecks(prs: readonly Pr[], issues: readonly Issue[], cwd: string): Promise<Map<number, ChecksState>> {
  const needsReview = new Set(
    issues.filter((issue) => issue.labels.includes(REVIEW_NEEDED)).map((issue) => issue.number),
  );
  const targets = prs.filter((pr) => {
    const issueNumber = prIssueNumber(pr);
    return pr.state === "OPEN" && issueNumber !== null && needsReview.has(issueNumber);
  });

  const result = new Map<number, ChecksState>();
  await Promise.all(
    targets.map(async (pr) => {
      const key = `${cwd}:${pr.number}:${pr.headSha}`;
      const cached = checksCache.get(key);
      let state = cached?.state;
      if (!cached || cached.expires <= Date.now()) {
        state = await prChecksState(pr.number, { cwd });
        checksCache.set(key, { state, expires: Date.now() + 10_000 });
      }
      result.set(pr.number, state!);
    }),
  );
  return result;
}

export async function buildSnapshot(cwd: string): Promise<Snapshot> {
  const cfg = loadConfig(cwd);
  const [issues, prs, locks, worktrees, runs, repoUrl] = await Promise.all([
    listIssues({ cwd, state: "all" }),
    listPrs({ cwd, state: "all" }),
    listLocks({ cwd, strict: true }),
    listWorktrees(cwd),
    Promise.resolve(readRuns(cwd)),
    getRepoUrl({ cwd }),
  ]);
  const branches = new Map<number, BranchObservation>();
  const refs = await exec("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads/task/"], { cwd });
  if (refs.code !== 0) throw new Error(`cannot observe task branches: ${refs.stderr.trim()}`);
  const base = await resolveBaseBranch(cfg.baseBranch, cwd);
  for (const ref of refs.stdout.trim().split(/\r?\n/).filter(Boolean)) {
    const match = ref.match(/^task\/(\d+)(?:-|$)/);
    if (!match) continue;
    const number = Number(match[1]);
    if (branches.has(number)) {
      branches.set(number, { state: "absent", error: "multiple task branches map to this issue" });
      continue;
    }
    try { branches.set(number, { state: await compareBranchToBase(ref, base, cwd) }); }
    catch (error) { branches.set(number, { state: "absent", error: String(error) }); }
  }
  for (const worktree of worktrees) {
    const number = worktreeIssueNumber(worktree);
    if (number !== null && !existsSync(worktree.path)) {
      branches.set(number, { state: branches.get(number)?.state ?? "absent", error: "registered worktree path is missing" });
    }
  }
  for (const [key, value] of checksCache) if (value.expires <= Date.now()) checksCache.delete(key);
  const checks = await reviewChecks(prs, issues, cwd);
  return assemble(issues, prs, locks, worktrees, runs, new Date().toISOString(), repoUrl, checks, branches);
}
