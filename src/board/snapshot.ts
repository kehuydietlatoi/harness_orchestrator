import {
  type ChecksState,
  type Issue,
  type Pr,
  getRepoUrl,
  listIssues,
  listOpenPrs,
  prChecksState,
} from "../github/github.js";
import { issueAgent, issueStatus, parseDeps } from "./board.js";
import { buildGraph } from "./graph.js";
import { REVIEW_NEEDED, REVIEWED_BY_PREFIX } from "../github/labels.js";
import { listLocks } from "../git/lock.js";
import { prIssueNumber } from "./review.js";
import { readRuns, type RunRecord } from "./telemetry.js";
import { exec } from "../util/exec.js";
import type { Worktree } from "../git/worktree.js";

export interface TaskView {
  number: number;
  title: string;
  status: string;
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

export type SnapshotRun = Pick<RunRecord, "issue" | "tokensTotal" | "costUsd" | "ts" | "model">;

function worktreeIssueNumber(worktree: Worktree): number | null {
  const branch = worktree.branch.replace(/^refs\/heads\//, "");
  const byBranch = branch.match(/^task\/(\d+)(?:-|$)/);
  if (byBranch) return Number(byBranch[1]);

  const byPath = worktree.path.match(/[\\/]issue-(\d+)[\\/]?$/);
  return byPath ? Number(byPath[1]) : null;
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
): Snapshot {
  const locked = new Set(locks);

  const prByIssue = new Map<number, Pr>();
  for (const pr of prs) {
    const issue = prIssueNumber(pr);
    if (issue !== null && !prByIssue.has(issue)) prByIssue.set(issue, pr);
  }

  const worktreeByIssue = new Map<number, string>();
  for (const worktree of worktrees) {
    const issue = worktreeIssueNumber(worktree);
    if (issue !== null) worktreeByIssue.set(issue, worktree.path);
  }

  const latestRunByIssue = new Map<number, SnapshotRun>();
  for (const run of runs) latestRunByIssue.set(run.issue, run);

  const sortedIssues = [...issues].sort((a, b) => a.number - b.number);
  const tasks = sortedIssues.map((issue): TaskView => {
    const pr = prByIssue.get(issue.number);
    const run = latestRunByIssue.get(issue.number);
    return {
      number: issue.number,
      title: issue.title,
      status: issueStatus(issue),
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
      return issueNumber !== null && issueByNumber.get(issueNumber)?.labels.includes(REVIEW_NEEDED);
    })
    .map((pr) => pr.number)
    .sort((a, b) => a - b);

  const { cycles } = buildGraph(issues);

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
  return result.code === 0 ? parseWorktrees(result.stdout) : [];
}

/** Cache of CI state keyed by `<pr>:<headSha>` so steady-state polls reuse a
 * result until a new commit lands, rather than shelling out to `gh` every 2s. */
const checksCache = new Map<string, ChecksState>();

/** CI roll-up for the PRs whose issue is awaiting review — the only ones the
 * dashboard renders a checks badge for. Cached by head SHA; unknown SHAs are
 * fetched once and reused until the branch advances. */
async function reviewChecks(prs: readonly Pr[], issues: readonly Issue[], cwd: string): Promise<Map<number, ChecksState>> {
  const needsReview = new Set(
    issues.filter((issue) => issue.labels.includes(REVIEW_NEEDED)).map((issue) => issue.number),
  );
  const targets = prs.filter((pr) => {
    const issueNumber = prIssueNumber(pr);
    return issueNumber !== null && needsReview.has(issueNumber);
  });

  const result = new Map<number, ChecksState>();
  await Promise.all(
    targets.map(async (pr) => {
      const key = `${pr.number}:${pr.headSha}`;
      let state = checksCache.get(key);
      if (state === undefined) {
        state = await prChecksState(pr.number, { cwd });
        checksCache.set(key, state);
      }
      result.set(pr.number, state);
    }),
  );
  return result;
}

export async function buildSnapshot(cwd: string): Promise<Snapshot> {
  const [issues, prs, locks, worktrees, runs, repoUrl] = await Promise.all([
    listIssues({ cwd, state: "open" }),
    listOpenPrs({ cwd }),
    listLocks({ cwd }),
    listWorktrees(cwd),
    Promise.resolve(readRuns(cwd)),
    getRepoUrl({ cwd }),
  ]);
  const checks = await reviewChecks(prs, issues, cwd);
  return assemble(issues, prs, locks, worktrees, runs, new Date().toISOString(), repoUrl, checks);
}
