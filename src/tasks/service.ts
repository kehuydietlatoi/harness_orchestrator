import { existsSync } from "node:fs";
import { exec } from "../util/exec.js";
import {
  claim as lockClaim,
  createOwnerToken,
  owner as lockOwner,
  releaseOwned as lockReleaseOwned,
  type ClaimResult,
} from "../git/lock.js";
import {
  type Issue,
  getIssue,
  editIssue,
  createPr,
  currentLogin,
  getBranchPrs,
  listPrReviews,
  type Pr,
} from "../github/github.js";
import { STATUS, agentLabel, REVIEW_NEEDED } from "../github/labels.js";
import {
  addReworkWorktree,
  addWorktree,
  branchName,
  observeWorktree,
  slugify,
  worktreePath,
  type Worktree,
  type WorktreeObservation,
} from "../git/worktree.js";
import {
  resolveBaseBranch,
  type RepositoryBase,
} from "../git/git.js";
import { eligibleIssues, issueAgent, issueStatus } from "../board/board.js";
import { latestChangesRequestedNote } from "../board/approval.js";
import type { OrchConfig } from "../config.js";
import { decideTaskTransition } from "./lifecycle.js";

export interface ClaimedTask {
  issue: Issue;
  worktree: Worktree;
  /** Set when the task is an existing PR sent back for changes. */
  rework?: { pr: number; notes: string; baseRef: string; startHead: string };
}

/** An in-progress task whose open PR's latest decision is request-changes. */
export interface ReworkTarget {
  pr: Pr;
  notes: string;
}

/**
 * Observe whether an issue is a bounced PR awaiting rework: in-progress, with an
 * open PR on its task branch whose current head has a request-changes record.
 * Returns null for anything else (labels alone never qualify).
 */
export async function observeRework(issue: Issue, cwd: string): Promise<ReworkTarget | null> {
  if (issueStatus(issue) !== STATUS.inProgress) return null;
  const branch = branchName(issue.number, slugify(issue.title));
  const open = (await getBranchPrs(branch, { cwd })).filter((pr) => pr.state === "OPEN" && pr.headSha);
  if (open.length === 0) return null;
  if (open.length > 1) throw new Error(`#${issue.number} has multiple open PRs on ${branch}`);
  const pr = open[0]!;
  const notes = latestChangesRequestedNote(await listPrReviews(pr.number, { cwd }), pr.number, pr.headSha);
  return notes === null ? null : { pr, notes };
}

/**
 * Claim a rework: the claim lock from the original run is reused (it is held
 * until merge), and the worktree is attached to the existing PR branch.
 */
export async function claimRework(
  issue: Issue,
  target: ReworkTarget,
  cfg: OrchConfig,
  cwd: string,
): Promise<ClaimedTask> {
  const n = issue.number;
  if ((await lockOwner(n, { cwd })) === null) {
    throw new Error(`#${n} has no claim lock; run 'orch repair ${n}' before rework.`);
  }
  const base = await resolveBaseBranch(cfg.baseBranch, cwd);
  const wt = await addReworkWorktree(n, issue.title, cfg.worktreeRoot, {
    branch: target.pr.headRefName,
    cwd,
  });
  return {
    issue,
    worktree: { path: wt.path, branch: wt.branch },
    rework: { pr: target.pr.number, notes: target.notes, baseRef: base.ref, startHead: wt.head },
  };
}

interface IssueEdit {
  addLabels?: string[];
  removeLabels?: string[];
  addAssignees?: string[];
  removeAssignees?: string[];
}

/** Narrow adapter seam used by failure-injection tests for the claim saga. */
export interface ClaimSagaDeps {
  resolveBaseBranch(configured: string | undefined, cwd: string): Promise<RepositoryBase>;
  createOwnerToken(number: number, agent: string, cwd: string): Promise<string>;
  observeLock(number: number, cwd: string): Promise<string | null>;
  acquireLock(number: number, owner: string, cwd: string): Promise<ClaimResult>;
  releaseLock(number: number, owner: string, cwd: string): Promise<boolean>;
  getIssue(number: number, cwd: string): Promise<Issue>;
  currentLogin(cwd: string): Promise<string>;
  editIssue(number: number, edit: IssueEdit, cwd: string): Promise<void>;
  observeWorktree(
    number: number,
    title: string,
    root: string,
    cwd: string,
  ): Promise<WorktreeObservation>;
  addWorktree(
    number: number,
    title: string,
    root: string,
    baseRef: string,
    cwd: string,
  ): Promise<Worktree>;
}

const claimSagaDeps: ClaimSagaDeps = {
  resolveBaseBranch,
  createOwnerToken: (number, agent, cwd) => createOwnerToken(number, agent, { cwd }),
  observeLock: (number, cwd) => lockOwner(number, { cwd }),
  acquireLock: (number, owner, cwd) => lockClaim(number, { cwd, sha: owner }),
  releaseLock: (number, owner, cwd) => lockReleaseOwned(number, owner, { cwd }),
  getIssue: (number, cwd) => getIssue(number, { cwd }),
  currentLogin: (cwd) => currentLogin({ cwd }),
  editIssue: (number, edit, cwd) => editIssue(number, { cwd, ...edit }),
  observeWorktree: (number, title, root, cwd) =>
    observeWorktree(number, title, root, { cwd }),
  addWorktree: (number, title, root, baseRef, cwd) =>
    addWorktree(number, title, root, { cwd, baseRef }),
};

interface ClaimContext {
  number: number;
  agent: string;
  cwd: string;
  root: string;
  owner: string;
  base: RepositoryBase;
  login: string;
  initialIssue: Issue;
}

interface ClaimObservation {
  issue: Issue;
  lockOwner: string | null;
  login: string;
  worktree: WorktreeObservation;
}

function isClaimProjection(issue: Issue, ctx: ClaimContext): boolean {
  return (
    issue.state === "OPEN" &&
    issue.labels.includes(STATUS.claimed) &&
    issue.labels.includes(agentLabel(ctx.agent)) &&
    !issue.labels.includes(STATUS.todo) &&
    issue.assignees.includes(ctx.login)
  );
}

function isCompensatedProjection(issue: Issue, ctx: ClaimContext): boolean {
  const agentWasPresent = ctx.initialIssue.labels.includes(agentLabel(ctx.agent));
  const assigneeWasPresent = ctx.initialIssue.assignees.includes(ctx.login);
  const todoWasPresent = ctx.initialIssue.labels.includes(STATUS.todo);
  return (
    !issue.labels.includes(STATUS.claimed) &&
    issue.labels.includes(agentLabel(ctx.agent)) === agentWasPresent &&
    issue.assignees.includes(ctx.login) === assigneeWasPresent &&
    (!todoWasPresent || issue.labels.includes(STATUS.todo))
  );
}

async function observeClaim(
  number: number,
  cfg: OrchConfig,
  cwd: string,
  deps: ClaimSagaDeps,
): Promise<ClaimObservation> {
  const issue = await deps.getIssue(number, cwd);
  const [lockOwner, login, worktree] = await Promise.all([
    deps.observeLock(number, cwd),
    deps.currentLogin(cwd),
    deps.observeWorktree(number, issue.title, cfg.worktreeRoot, cwd),
  ]);
  return { issue, lockOwner, login, worktree };
}

function decideClaim(number: number, observation: ClaimObservation): void {
  if (observation.issue.state !== "OPEN") throw new Error(`#${number} is not open.`);
  if (observation.lockOwner !== null) {
    throw new Error(`#${number} is already claimed by another agent.`);
  }
  if (observation.worktree.outcome !== "absent") {
    throw new Error(
      observation.worktree.outcome === "usable"
        ? `#${number} has an unowned task worktree and must be reconciled before claiming.`
        : observation.worktree.detail,
    );
  }
  if (!observation.login) throw new Error("cannot resolve the current GitHub login");
  const decision = decideTaskTransition("ready", "claim");
  if (!decision.allowed) throw new Error(decision.reason);
}

async function acquireOwnedLock(ctx: ClaimContext, deps: ClaimSagaDeps): Promise<void> {
  let result: ClaimResult | undefined;
  let failure: unknown;
  try {
    result = await deps.acquireLock(ctx.number, ctx.owner, ctx.cwd);
  } catch (error) {
    failure = error;
  }
  if (result?.outcome === "acquired") return;

  const observed = await deps.observeLock(ctx.number, ctx.cwd);
  if (observed === ctx.owner) return; // write succeeded but its response was lost
  if (result?.outcome === "already-held" || observed !== null) {
    throw new Error(`#${ctx.number} is already claimed by another agent.`);
  }
  const detail =
    result?.detail ?? (failure instanceof Error ? failure.message : failure ? String(failure) : undefined);
  throw new Error(`claim failed for #${ctx.number}: ${detail ?? "unknown error"}`);
}

async function applyClaimProjection(ctx: ClaimContext, deps: ClaimSagaDeps): Promise<Issue> {
  try {
    await deps.editIssue(
      ctx.number,
      {
        addLabels: [STATUS.claimed, agentLabel(ctx.agent)],
        removeLabels: [STATUS.todo],
        addAssignees: ["@me"],
      },
      ctx.cwd,
    );
  } catch (error) {
    const observed = await deps.getIssue(ctx.number, ctx.cwd);
    if (isClaimProjection(observed, ctx)) return observed; // response was lost
    throw error;
  }
  return deps.getIssue(ctx.number, ctx.cwd);
}

async function createUsableWorktree(
  ctx: ClaimContext,
  deps: ClaimSagaDeps,
): Promise<Worktree> {
  try {
    return await deps.addWorktree(
      ctx.number,
      ctx.initialIssue.title,
      ctx.root,
      ctx.base.ref,
      ctx.cwd,
    );
  } catch (error) {
    const observed = await deps.observeWorktree(
      ctx.number,
      ctx.initialIssue.title,
      ctx.root,
      ctx.cwd,
    );
    if (observed.outcome === "usable") return observed.worktree; // response was lost
    if (observed.outcome === "error") {
      throw new Error(
        `worktree setup for #${ctx.number} is ambiguous; ownership was retained: ${observed.detail}`,
      );
    }
    throw error;
  }
}

async function compensateClaim(
  ctx: ClaimContext,
  deps: ClaimSagaDeps,
): Promise<{ issue: Issue; worktree: Worktree } | null> {
  const observedOwner = await deps.observeLock(ctx.number, ctx.cwd);
  if (observedOwner !== ctx.owner) return null; // never compensate another saga's side effects

  const worktree = await deps.observeWorktree(
    ctx.number,
    ctx.initialIssue.title,
    ctx.root,
    ctx.cwd,
  );
  if (worktree.outcome === "usable") {
    const issue = await deps.getIssue(ctx.number, ctx.cwd);
    if (!isClaimProjection(issue, ctx)) {
      throw new Error(
        `worktree setup completed for #${ctx.number}, but its GitHub projection could not be proven; ownership was retained`,
      );
    }
    return { issue, worktree: worktree.worktree };
  }
  if (worktree.outcome === "error") {
    throw new Error(
      `claim setup for #${ctx.number} is ambiguous; ownership was retained: ${worktree.detail}`,
    );
  }

  let issue: Issue | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      issue = await deps.getIssue(ctx.number, ctx.cwd);
    } catch {
      continue;
    }
    if (isCompensatedProjection(issue, ctx)) break;
    const agentWasPresent = ctx.initialIssue.labels.includes(agentLabel(ctx.agent));
    const assigneeWasPresent = ctx.initialIssue.assignees.includes(ctx.login);
    const todoWasPresent = ctx.initialIssue.labels.includes(STATUS.todo);
    try {
      await deps.editIssue(
        ctx.number,
        {
          addLabels: todoWasPresent ? [STATUS.todo] : undefined,
          removeLabels: [
            STATUS.claimed,
            ...(agentWasPresent ? [] : [agentLabel(ctx.agent)]),
          ],
          removeAssignees: assigneeWasPresent ? undefined : ["@me"],
        },
        ctx.cwd,
      );
    } catch {
      // Retry from a fresh observation. This also handles a lost response.
    }
  }
  issue = await deps.getIssue(ctx.number, ctx.cwd);
  if (!isCompensatedProjection(issue, ctx)) {
    throw new Error(
      `claim setup failed for #${ctx.number}; GitHub compensation is incomplete and the owned lock was retained`,
    );
  }

  try {
    await deps.releaseLock(ctx.number, ctx.owner, ctx.cwd);
  } catch {
    // A lost release response is resolved by the owner observation below.
  }
  if ((await deps.observeLock(ctx.number, ctx.cwd)) === ctx.owner) {
    throw new Error(`claim setup failed for #${ctx.number}; the owned lock could not be released`);
  }
  return null;
}

/**
 * Claim setup saga: observe -> decide -> execute lock/issue/worktree writes ->
 * compensate from fresh observations. Ambiguous writes roll forward only when
 * the saga can prove ownership of the resulting side effect.
 */
export async function claimSpecific(
  number: number,
  agent: string,
  cfg: OrchConfig,
  cwd: string,
  deps: ClaimSagaDeps = claimSagaDeps,
): Promise<ClaimedTask> {
  const observation = await observeClaim(number, cfg, cwd, deps);
  decideClaim(number, observation);
  const base = await deps.resolveBaseBranch(cfg.baseBranch, cwd);
  const ctx: ClaimContext = {
    number,
    agent,
    cwd,
    root: cfg.worktreeRoot,
    owner: await deps.createOwnerToken(number, agent, cwd),
    base,
    login: observation.login,
    initialIssue: observation.issue,
  };
  let ownsLock = false;
  try {
    await acquireOwnedLock(ctx, deps);
    ownsLock = true;
    const issue = await applyClaimProjection(ctx, deps);
    if (!isClaimProjection(issue, ctx)) {
      throw new Error(`claim projection for #${number} did not reach the expected state`);
    }
    const worktree = await createUsableWorktree(ctx, deps);
    return { issue, worktree };
  } catch (error) {
    if (ownsLock) {
      const recovered = await compensateClaim(ctx, deps);
      if (recovered) return recovered;
    }
    throw error;
  }
}

/** Claim the next eligible issue, skipping any lost to a concurrent racer. */
export async function claimNext(
  agent: string,
  cfg: OrchConfig,
  cwd: string,
): Promise<ClaimedTask | null> {
  const candidates = await eligibleIssues(cwd, agent);
  if (candidates.length === 0) return null;
  // Resolve once outside the retry loop. A repository configuration/ref error
  // applies to every candidate and must not look like an empty eligible queue.
  const base = await claimSagaDeps.resolveBaseBranch(cfg.baseBranch, cwd);
  const deps: ClaimSagaDeps = {
    ...claimSagaDeps,
    resolveBaseBranch: async () => base,
  };
  for (const candidate of candidates) {
    const owner = issueAgent(candidate);
    if (owner && owner !== agent) continue; // reserved for another agent
    try {
      return await claimSpecific(candidate.number, agent, cfg, cwd, deps);
    } catch {
      continue; // lost the race or transient error; try the next candidate
    }
  }
  return null;
}

/**
 * Submit finished work: push the branch, open a PR that closes the issue, move
 * it to in-review, and route the review to the *other* harness.
 * Run from the primary repo root (worktree path derived from config).
 */
export async function submit(
  number: number,
  agent: string,
  cfg: OrchConfig,
  cwd: string,
): Promise<string> {
  // Run from the primary repo (derive the worktree) or from inside the worktree itself.
  const derived = worktreePath(cfg.worktreeRoot, number, cwd);
  const wt = existsSync(derived) ? derived : cwd;
  // Resolve and validate before pushing so an invalid base cannot leave a
  // remote branch behind without a PR.
  const base = await resolveBaseBranch(cfg.baseBranch, cwd);
  const push = await exec("git", ["push", "-u", "origin", "HEAD"], { cwd: wt });
  if (push.code !== 0) throw new Error(`git push failed: ${push.stderr.trim()}`);

  const issue = await getIssue(number, { cwd });
  // A reworked task already has its PR: the push above updated it, so only the
  // projection changes. Never create a second PR for the same branch.
  const existing = await openBranchPr(wt);
  if (existing) {
    await editIssue(number, {
      cwd,
      addLabels: [STATUS.inReview, REVIEW_NEEDED],
      removeLabels: [STATUS.claimed, STATUS.inProgress],
    });
    return existing.htmlUrl;
  }
  const reviewer = cfg.agents.find((a) => a !== agent) ?? "(the other harness)";
  const body =
    `Closes #${number}\n\n` +
    `Authored by \`${agent}\`. **Cross-review required from \`${reviewer}\` before merge.**`;
  const url = await createPr({ cwd: wt, title: issue.title, body, base: base.name });

  await editIssue(number, {
    cwd,
    addLabels: [STATUS.inReview, REVIEW_NEEDED],
    removeLabels: [STATUS.claimed, STATUS.inProgress],
  });
  return url;
}

async function openBranchPr(wt: string): Promise<Pr | null> {
  const head = await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: wt });
  const branch = head.stdout.trim();
  if (head.code !== 0 || !branch || branch === "HEAD") return null;
  const prs = await getBranchPrs(branch, { cwd: wt });
  return prs.find((pr) => pr.state === "OPEN") ?? null;
}

/** Resolve which agent identity a command is acting as. */
export function resolveAgent(flag: string | undefined, cfg: OrchConfig): string {
  const agent = flag ?? process.env.ORCH_AGENT ?? cfg.lead;
  if (!cfg.agents.includes(agent)) {
    throw new Error(`Unknown agent '${agent}'. Configured agents: ${cfg.agents.join(", ")}`);
  }
  return agent;
}
