import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { OrchConfig } from "../config.js";
import { readRuns, appendRun, projectId, type RunRecord } from "../board/telemetry.js";
import { prIssueNumber } from "../board/review.js";
import {
  closeIssue,
  editIssue,
  getIssue,
  listIssues,
  listPrs,
  type Issue,
  type Pr,
} from "../github/github.js";
import {
  NEEDS_ATTENTION,
  REVIEWED_BY_PREFIX,
  REVIEW_NEEDED,
  STATUS_LABELS,
} from "../github/labels.js";
import {
  claim as claimLock,
  createOwnerToken,
  listLocks,
  owner as lockOwner,
  release as releaseLock,
} from "../git/lock.js";
import {
  addWorktree,
  branchName,
  removeWorktree,
  slugify,
  worktreePath,
} from "../git/worktree.js";
import { exec } from "../util/exec.js";
import {
  deriveTaskState,
  projectLifecycleLabels,
  type TaskFacts,
  type TaskState,
} from "./lifecycle.js";

export type RepairWorktree =
  | { kind: "absent" }
  | { kind: "usable"; path: string; branch: string; removable: boolean; retentionReason?: string }
  | { kind: "stale-registration"; path: string }
  | { kind: "conflict" | "error"; path: string; detail: string };

export interface RepairObservation {
  number: number;
  issue: Issue | null;
  expectedBranch: string | null;
  lockOwner: string | null;
  worktree: RepairWorktree;
  branch: TaskFacts["branch"];
  prs: Pr[];
  telemetry: TaskFacts["telemetry"];
}

export type RepairAction =
  | { kind: "prune-worktree-registration"; issue: number; path: string }
  | { kind: "restore-branch"; issue: number; branch: string; pr: number }
  | { kind: "acquire-lock"; issue: number }
  | { kind: "add-worktree"; issue: number }
  | { kind: "safe-remove-worktree"; issue: number; path: string }
  | { kind: "release-lock"; issue: number }
  | { kind: "close-issue"; issue: number; pr: number }
  | { kind: "supersede-telemetry"; issue: number }
  | {
      kind: "sync-labels";
      issue: number;
      add: string[];
      remove: string[];
    };

export interface RepairPlan {
  issue: number;
  observation: RepairObservation;
  state: TaskState;
  projectedState: TaskState;
  actions: RepairAction[];
  blocked: string[];
}

export interface RepairResult extends RepairPlan {
  applied: RepairAction[];
}

export interface ReconcileDeps {
  observe(issue: number, cfg: OrchConfig, cwd: string): Promise<RepairObservation>;
  execute(
    action: RepairAction,
    observation: RepairObservation,
    cfg: OrchConfig,
    cwd: string,
  ): Promise<void>;
}

interface RegisteredWorktree {
  path: string;
  branch: string | null;
  prunable: boolean;
}

function pathIdentity(path: string): string {
  const absolute = resolve(path);
  const canonical = existsSync(absolute) ? realpathSync.native(absolute) : absolute;
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function parseWorktrees(output: string): RegisteredWorktree[] {
  const worktrees: RegisteredWorktree[] = [];
  let current: RegisteredWorktree | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), branch: null, prunable: false };
      worktrees.push(current);
    } else if (current && line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    } else if (current && line.startsWith("prunable ")) {
      current.prunable = true;
    }
  }
  return worktrees;
}

async function registeredWorktrees(cwd: string): Promise<RegisteredWorktree[]> {
  const result = await exec("git", ["worktree", "list", "--porcelain"], { cwd });
  if (result.code !== 0) throw new Error(`git worktree list failed: ${result.stderr.trim()}`);
  return parseWorktrees(result.stdout);
}

async function branchFact(branch: string, cwd: string): Promise<TaskFacts["branch"]> {
  const exists = await exec("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    cwd,
  });
  if (exists.code === 1) return "absent";
  if (exists.code !== 0) {
    throw new Error(`cannot observe branch '${branch}': ${exists.stderr.trim()}`);
  }
  const ahead = await exec("git", ["rev-list", "--count", `main..${branch}`], { cwd });
  if (ahead.code !== 0) {
    throw new Error(`cannot compare branch '${branch}' to main: ${ahead.stderr.trim()}`);
  }
  return Number(ahead.stdout.trim()) > 0 ? "ahead" : "unchanged";
}

async function removalSafety(
  path: string,
  registeredBranch: string,
): Promise<{ removable: boolean; reason?: string }> {
  const status = await exec(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"],
    { cwd: path },
  );
  if (status.code !== 0) return { removable: false, reason: "worktree status is unreadable" };
  if (status.stdout.length > 0) {
    return { removable: false, reason: "worktree has dirty, untracked, or ignored files" };
  }

  const refs = await exec(
    "git",
    [
      "for-each-ref",
      "--contains=HEAD",
      "--format=%(refname)",
      "refs/heads",
      "refs/remotes",
      "refs/tags",
    ],
    { cwd: path },
  );
  if (refs.code !== 0) return { removable: false, reason: "commit reachability is unreadable" };
  const preserved = refs.stdout
    .split(/\r?\n/)
    .some((ref) => ref.length > 0 && ref !== registeredBranch);
  return preserved
    ? { removable: true }
    : { removable: false, reason: "HEAD is not preserved by another branch, remote, or tag" };
}

async function observeWorktreeForRepair(
  number: number,
  expectedBranch: string,
  cfg: OrchConfig,
  cwd: string,
): Promise<RepairWorktree> {
  const path = worktreePath(cfg.worktreeRoot, number, cwd);
  let registered: RegisteredWorktree[];
  try {
    registered = await registeredWorktrees(cwd);
  } catch (error) {
    return {
      kind: "error",
      path,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const entry = registered.find((item) => pathIdentity(item.path) === pathIdentity(path));
  if (!existsSync(path)) {
    return entry ? { kind: "stale-registration", path } : { kind: "absent" };
  }
  if (!entry) {
    return { kind: "conflict", path, detail: "path exists but is not registered by Git" };
  }
  const expectedRef = `refs/heads/${expectedBranch}`;
  if (entry.branch !== expectedRef) {
    const actual = entry.branch?.replace(/^refs\/heads\//, "") ?? "detached HEAD";
    return {
      kind: "conflict",
      path,
      detail: `path is attached to '${actual}', expected '${expectedBranch}'`,
    };
  }
  const safety = await removalSafety(path, expectedRef);
  return {
    kind: "usable",
    path,
    branch: expectedBranch,
    removable: safety.removable,
    retentionReason: safety.reason,
  };
}

function prFact(prs: readonly Pr[]): TaskFacts["pr"] {
  if (prs.some((pr) => pr.state === "OPEN")) return "open";
  if (prs.some((pr) => pr.state === "MERGED")) return "merged";
  if (prs.some((pr) => pr.state === "CLOSED")) return "closed";
  return "none";
}

function telemetryFact(records: readonly RunRecord[], issue: number): TaskFacts["telemetry"] {
  const latest = records.filter((record) => record.issue === issue).at(-1);
  switch (latest?.outcome) {
    case "submitted":
    case "auto-submitted":
      return "submitted";
    case "failed":
      return "failed";
    case "needs-attention":
    case "no-commits":
      return "no-commits";
    default:
      return "none";
  }
}

export function factsFromObservation(observation: RepairObservation): TaskFacts {
  return {
    issue: observation.issue === null
      ? "missing"
      : observation.issue.state === "CLOSED"
        ? "closed"
        : "open",
    lock: observation.lockOwner !== null,
    worktree: observation.worktree.kind === "usable",
    branch: observation.branch,
    pr: prFact(observation.prs),
    telemetry: observation.telemetry,
  };
}

function actionKey(action: RepairAction): string {
  return JSON.stringify(action);
}

function pushAction(actions: RepairAction[], action: RepairAction): void {
  if (!actions.some((existing) => actionKey(existing) === actionKey(action))) actions.push(action);
}

function effectivePr(observation: RepairObservation, state: TaskFacts["pr"]): Pr | undefined {
  const expected = state.toUpperCase();
  return observation.prs.find((pr) => pr.state === expected);
}

/**
 * Pure repair policy. It simulates the facts produced by safe actions so a
 * preview shows the converged projection, while apply still re-observes after
 * every individual write before trusting that simulation.
 */
export function planRepairs(observation: RepairObservation): RepairPlan {
  const initialFacts = factsFromObservation(observation);
  const initialState = deriveTaskState(initialFacts);
  const facts: TaskFacts = { ...initialFacts };
  const actions: RepairAction[] = [];
  const blocked: string[] = [];
  const issue = observation.issue;
  const pr = effectivePr(observation, facts.pr);

  if (!issue || !observation.expectedBranch) {
    blocked.push("the GitHub issue is missing or inaccessible; no repair was guessed");
  }

  if (observation.worktree.kind === "stale-registration") {
    pushAction(actions, {
      kind: "prune-worktree-registration",
      issue: observation.number,
      path: observation.worktree.path,
    });
  } else if (
    observation.worktree.kind === "conflict" ||
    observation.worktree.kind === "error"
  ) {
    blocked.push(`worktree was preserved: ${observation.worktree.detail}`);
  }

  const canManageWorktree =
    issue !== null &&
    observation.expectedBranch !== null &&
    observation.worktree.kind !== "conflict" &&
    observation.worktree.kind !== "error";

  // Any observed task worktree on an open issue must regain ownership before
  // another repair is attempted. This is especially important for an
  // interrupted failed run whose only work is still uncommitted in the tree.
  if (facts.issue === "open" && facts.worktree && !facts.lock) {
    pushAction(actions, { kind: "acquire-lock", issue: observation.number });
    facts.lock = true;
  }

  if (issue && facts.pr === "merged" && facts.issue === "open" && pr) {
    pushAction(actions, { kind: "close-issue", issue: observation.number, pr: pr.number });
    facts.issue = "closed";
  }

  if (facts.issue === "closed") {
    if (facts.pr === "open") {
      blocked.push("an open PR targets a closed issue; preserve its lock and worktree for inspection");
    } else {
      if (observation.worktree.kind === "usable") {
        if (observation.worktree.removable) {
          pushAction(actions, {
            kind: "safe-remove-worktree",
            issue: observation.number,
            path: observation.worktree.path,
          });
          facts.worktree = false;
        } else {
          blocked.push(
            `worktree was preserved: ${observation.worktree.retentionReason ?? "safe removal could not be proven"}`,
          );
        }
      }
      if (!facts.worktree && facts.lock && observation.worktree.kind !== "conflict") {
        pushAction(actions, { kind: "release-lock", issue: observation.number });
        facts.lock = false;
      }
    }
  } else if (facts.issue === "open" && issue) {
    const unresolvedRun = facts.telemetry === "failed" || facts.telemetry === "no-commits";

    if (facts.pr === "open") {
      if (facts.branch === "absent") {
        if (pr && pr.headRefName === observation.expectedBranch) {
          pushAction(actions, {
            kind: "restore-branch",
            issue: observation.number,
            branch: observation.expectedBranch,
            pr: pr.number,
          });
          facts.branch = "ahead";
        } else {
          blocked.push("the open PR head does not match the expected task branch");
        }
      }
      if (!facts.lock) {
        pushAction(actions, { kind: "acquire-lock", issue: observation.number });
        facts.lock = true;
      }
      if (!facts.worktree && facts.branch !== "absent" && canManageWorktree) {
        pushAction(actions, { kind: "add-worktree", issue: observation.number });
        facts.worktree = true;
      }
      if (facts.branch !== "ahead") {
        blocked.push("the open PR branch has no commits ahead of main");
      }
      if (unresolvedRun && facts.lock && facts.worktree && facts.branch === "ahead") {
        pushAction(actions, { kind: "supersede-telemetry", issue: observation.number });
        facts.telemetry = "none";
      }
    } else if (unresolvedRun) {
      if (facts.branch === "ahead") {
        if (!facts.lock) {
          pushAction(actions, { kind: "acquire-lock", issue: observation.number });
          facts.lock = true;
        }
        if (!facts.worktree && canManageWorktree) {
          pushAction(actions, { kind: "add-worktree", issue: observation.number });
          facts.worktree = true;
        }
        blocked.push("failed run has unmerged commits; inspect the preserved work before resetting");
      } else if (
        observation.worktree.kind === "conflict" ||
        observation.worktree.kind === "error"
      ) {
        // The observation-level blocker above is sufficient. In particular,
        // do not release the lock or clear failure telemetry while unknown work
        // may still occupy the deterministic task path.
      } else if (observation.worktree.kind === "usable" && !observation.worktree.removable) {
        blocked.push(
          `failed-run worktree was preserved: ${observation.worktree.retentionReason ?? "safe removal could not be proven"}`,
        );
      } else {
        if (observation.worktree.kind === "usable") {
          pushAction(actions, {
            kind: "safe-remove-worktree",
            issue: observation.number,
            path: observation.worktree.path,
          });
          facts.worktree = false;
        }
        if (!facts.worktree && facts.lock) {
          pushAction(actions, { kind: "release-lock", issue: observation.number });
          facts.lock = false;
        }
        pushAction(actions, { kind: "supersede-telemetry", issue: observation.number });
        facts.telemetry = "none";
      }
    } else if (facts.pr === "closed") {
      blocked.push("the task PR closed without merging; inspect it before retrying or abandoning work");
    } else if (facts.telemetry === "submitted" && facts.pr === "none") {
      blocked.push("submitted telemetry has no observable PR; preserve task state for inspection");
    } else if (facts.branch === "ahead") {
      if (!facts.lock) {
        pushAction(actions, { kind: "acquire-lock", issue: observation.number });
        facts.lock = true;
      }
      if (!facts.worktree && canManageWorktree) {
        pushAction(actions, { kind: "add-worktree", issue: observation.number });
        facts.worktree = true;
      }
    } else if (facts.lock && !facts.worktree && canManageWorktree) {
      pushAction(actions, { kind: "add-worktree", issue: observation.number });
      facts.worktree = true;
      if (facts.branch === "absent") facts.branch = "unchanged";
    }
  }

  let projectedState = deriveTaskState(facts);
  if (blocked.length > 0 && projectedState.kind !== "inconsistent") {
    projectedState = {
      kind: "inconsistent",
      recovery: "reconcile-facts",
      violations: [
        {
          invariant: "unrecognized-fact-combination",
          detail: blocked.join("; "),
        },
      ],
    };
  }

  if (issue) {
    const expected = new Set(projectLifecycleLabels(projectedState));
    const add = [...expected].filter((label) => !issue.labels.includes(label));
    const remove = [...new Set([...STATUS_LABELS, NEEDS_ATTENTION])].filter(
      (label) => issue.labels.includes(label) && !expected.has(label),
    );

    const hasReview = issue.labels.some((label) => label.startsWith(REVIEWED_BY_PREFIX));
    if (projectedState.kind === "in-review") {
      if (hasReview && issue.labels.includes(REVIEW_NEEDED)) remove.push(REVIEW_NEEDED);
      else if (!hasReview && !issue.labels.includes(REVIEW_NEEDED)) add.push(REVIEW_NEEDED);
    } else if (facts.pr !== "open" && issue.labels.includes(REVIEW_NEEDED)) {
      remove.push(REVIEW_NEEDED);
    }

    if (add.length > 0 || remove.length > 0) {
      pushAction(actions, {
        kind: "sync-labels",
        issue: observation.number,
        add: [...new Set(add)].sort(),
        remove: [...new Set(remove)].sort(),
      });
    }
  }

  return {
    issue: observation.number,
    observation,
    state: initialState,
    projectedState,
    actions,
    blocked,
  };
}

async function observeRepair(
  number: number,
  cfg: OrchConfig,
  cwd: string,
): Promise<RepairObservation> {
  let issue: Issue | null = null;
  try {
    issue = await getIssue(number, { cwd });
  } catch {
    // Missing/inaccessible is represented explicitly and never guessed to be open.
  }
  const expectedBranch = issue ? branchName(number, slugify(issue.title)) : null;
  const [owner, prs, records] = await Promise.all([
    lockOwner(number, { cwd }),
    listPrs({ cwd, state: "all" }).then((all) => all.filter((pr) => prIssueNumber(pr) === number)),
    Promise.resolve(readRuns(cwd)),
  ]);
  const branch = expectedBranch ? await branchFact(expectedBranch, cwd) : "absent";
  const worktree = expectedBranch
    ? await observeWorktreeForRepair(number, expectedBranch, cfg, cwd)
    : { kind: "absent" as const };
  return {
    number,
    issue,
    expectedBranch,
    lockOwner: owner,
    worktree,
    branch,
    prs,
    telemetry: telemetryFact(records, number),
  };
}

async function executeRepair(
  action: RepairAction,
  observation: RepairObservation,
  cfg: OrchConfig,
  cwd: string,
): Promise<void> {
  switch (action.kind) {
    case "prune-worktree-registration": {
      const result = await exec("git", ["worktree", "prune", "--expire", "now"], { cwd });
      if (result.code !== 0) throw new Error(`git worktree prune failed: ${result.stderr.trim()}`);
      return;
    }
    case "restore-branch": {
      const refspec = `refs/heads/${action.branch}:refs/heads/${action.branch}`;
      const result = await exec("git", ["fetch", "origin", refspec], { cwd });
      if (result.code !== 0) throw new Error(`cannot restore branch '${action.branch}': ${result.stderr.trim()}`);
      return;
    }
    case "acquire-lock": {
      const token = await createOwnerToken(action.issue, "repair", { cwd });
      const result = await claimLock(action.issue, { cwd, sha: token });
      if (result.outcome === "error") throw new Error(result.detail || "claim lock repair failed");
      return;
    }
    case "add-worktree": {
      if (!observation.issue) throw new Error(`cannot add worktree for missing issue #${action.issue}`);
      await addWorktree(action.issue, observation.issue.title, cfg.worktreeRoot, { cwd });
      return;
    }
    case "safe-remove-worktree": {
      await removeWorktree(action.path, { cwd });
      return;
    }
    case "release-lock":
      await releaseLock(action.issue, { cwd });
      return;
    case "close-issue":
      await closeIssue(action.issue, { cwd });
      return;
    case "supersede-telemetry":
      appendRun(
        {
          ts: new Date().toISOString(),
          project: projectId(cwd),
          issue: action.issue,
          agent: "repair",
          outcome: "repaired",
          durationMs: 0,
          tokensIn: null,
          tokensOut: null,
          tokensTotal: null,
          costUsd: null,
        },
        cwd,
      );
      return;
    case "sync-labels":
      await editIssue(action.issue, {
        cwd,
        addLabels: action.add,
        removeLabels: action.remove,
      });
  }
}

export const reconcileDeps: ReconcileDeps = {
  observe: observeRepair,
  execute: executeRepair,
};

function observationFingerprint(observation: RepairObservation): string {
  return JSON.stringify(observation);
}

/** Preview one issue, or apply one action at a time with a fresh observation
 * after every write. A process interruption therefore leaves no hidden cursor:
 * the next invocation resumes solely from durable external facts. */
export async function reconcileIssue(
  issue: number,
  cfg: OrchConfig,
  cwd: string,
  opts: { apply?: boolean } = {},
  deps: ReconcileDeps = reconcileDeps,
): Promise<RepairResult> {
  let observation = await deps.observe(issue, cfg, cwd);
  let plan = planRepairs(observation);
  const applied: RepairAction[] = [];
  if (!opts.apply) return { ...plan, applied };

  for (let step = 0; plan.actions.length > 0 && step < 32; step += 1) {
    const action = plan.actions[0];
    const before = observationFingerprint(observation);
    await deps.execute(action, observation, cfg, cwd);
    applied.push(action);
    observation = await deps.observe(issue, cfg, cwd);
    plan = planRepairs(observation);
    if (observationFingerprint(observation) === before) {
      return {
        ...plan,
        blocked: [...plan.blocked, `${action.kind} made no observable progress; rerun after inspecting it`],
        applied,
      };
    }
  }
  if (plan.actions.length > 0) {
    return { ...plan, blocked: [...plan.blocked, "repair did not converge after 32 actions"], applied };
  }
  return { ...plan, applied };
}

function branchIssueNumber(branch: string): number | null {
  const match = branch.match(/^task\/(\d+)(?:-|$)/);
  return match ? Number(match[1]) : null;
}

/** Discover orchestrator-owned tasks and orphaned task resources for `orch
 * repair` without an issue argument. */
export async function discoverRepairIssues(cwd: string): Promise<number[]> {
  const [issues, prs, locks, records, branches, worktrees] = await Promise.all([
    listIssues({ cwd, state: "all" }),
    listPrs({ cwd, state: "all" }),
    listLocks({ cwd }),
    Promise.resolve(readRuns(cwd)),
    exec("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads/task/"], { cwd }),
    registeredWorktrees(cwd),
  ]);
  const numbers = new Set<number>(locks);
  for (const issue of issues) {
    if (
      issue.labels.some(
        (label) =>
          STATUS_LABELS.includes(label) ||
          label === NEEDS_ATTENTION ||
          label === REVIEW_NEEDED ||
          label.startsWith("agent:") ||
          label.startsWith("effort:"),
      )
    ) {
      numbers.add(issue.number);
    }
  }
  for (const pr of prs) {
    const number = prIssueNumber(pr);
    if (number !== null) numbers.add(number);
  }
  for (const record of records) numbers.add(record.issue);
  if (branches.code === 0) {
    for (const branch of branches.stdout.split(/\r?\n/)) {
      const number = branchIssueNumber(branch.trim());
      if (number !== null) numbers.add(number);
    }
  }
  for (const worktree of worktrees) {
    const number = worktree.branch ? branchIssueNumber(worktree.branch.replace(/^refs\/heads\//, "")) : null;
    const byPath = worktree.path.match(/[\\/]issue-(\d+)[\\/]?$/);
    if (number !== null) numbers.add(number);
    else if (byPath) numbers.add(Number(byPath[1]));
  }
  return [...numbers].sort((a, b) => a - b);
}
