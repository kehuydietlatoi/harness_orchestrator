import { existsSync } from "node:fs";
import { exec } from "./util/exec.js";
import { claim as lockClaim, release as lockRelease } from "./lock.js";
import { type Issue, getIssue, editIssue, createPr } from "./github.js";
import { STATUS, agentLabel, REVIEW_NEEDED } from "./labels.js";
import { addWorktree, worktreePath, type Worktree } from "./worktree.js";
import { eligibleIssues, issueAgent } from "./board.js";
import type { OrchConfig } from "./config.js";

export interface ClaimedTask {
  issue: Issue;
  worktree: Worktree;
}

/** Atomically claim a specific issue: lock -> label/assign -> worktree. Rolls back the lock on failure. */
export async function claimSpecific(
  number: number,
  agent: string,
  cfg: OrchConfig,
  cwd: string,
): Promise<ClaimedTask> {
  const lock = await lockClaim(number, { cwd });
  if (lock.outcome !== "acquired") {
    throw new Error(
      lock.outcome === "already-held"
        ? `#${number} is already claimed by another agent.`
        : `claim failed for #${number}: ${lock.detail ?? "unknown error"}`,
    );
  }
  try {
    const issue = await getIssue(number, { cwd });
    await editIssue(number, {
      cwd,
      addLabels: [STATUS.claimed, agentLabel(agent)],
      removeLabels: [STATUS.todo],
      addAssignees: ["@me"],
    });
    const worktree = await addWorktree(number, issue.title, cfg.worktreeRoot, { cwd });
    return { issue, worktree };
  } catch (e) {
    await lockRelease(number, { cwd }); // don't leak the lock if setup fails
    throw e;
  }
}

/** Claim the next eligible issue, skipping any lost to a concurrent racer. */
export async function claimNext(
  agent: string,
  cfg: OrchConfig,
  cwd: string,
): Promise<ClaimedTask | null> {
  for (const candidate of await eligibleIssues(cwd)) {
    const owner = issueAgent(candidate);
    if (owner && owner !== agent) continue; // reserved for another agent
    try {
      return await claimSpecific(candidate.number, agent, cfg, cwd);
    } catch {
      continue; // lost the race or transient error; try the next candidate
    }
  }
  return null;
}

/**
 * Submit finished work: push the branch, open a PR that closes the issue, move
 * it to in-review, and route the review to the *other* harness.
 * Run from the main repo root (worktree path derived from config).
 */
export async function submit(
  number: number,
  agent: string,
  cfg: OrchConfig,
  cwd: string,
): Promise<string> {
  // Run from the main repo (derive the worktree) or from inside the worktree itself.
  const derived = worktreePath(cfg.worktreeRoot, number, cwd);
  const wt = existsSync(derived) ? derived : cwd;
  const push = await exec("git", ["push", "-u", "origin", "HEAD"], { cwd: wt });
  if (push.code !== 0) throw new Error(`git push failed: ${push.stderr.trim()}`);

  const issue = await getIssue(number, { cwd });
  const reviewer = cfg.agents.find((a) => a !== agent) ?? "(the other harness)";
  const body =
    `Closes #${number}\n\n` +
    `Authored by \`${agent}\`. **Cross-review required from \`${reviewer}\` before merge.**`;
  const url = await createPr({ cwd: wt, title: issue.title, body, base: "main" });

  await editIssue(number, {
    cwd,
    addLabels: [STATUS.inReview, REVIEW_NEEDED],
    removeLabels: [STATUS.claimed, STATUS.inProgress],
  });
  return url;
}

/** Resolve which agent identity a command is acting as. */
export function resolveAgent(flag: string | undefined, cfg: OrchConfig): string {
  const agent = flag ?? process.env.ORCH_AGENT ?? cfg.lead;
  if (!cfg.agents.includes(agent)) {
    throw new Error(`Unknown agent '${agent}'. Configured agents: ${cfg.agents.join(", ")}`);
  }
  return agent;
}
