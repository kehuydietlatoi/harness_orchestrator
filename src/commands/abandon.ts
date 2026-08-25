import pc from "picocolors";
import { loadConfig } from "../config.js";
import { resolveAgent } from "../tasks/service.js";
import { release as lockRelease } from "../git/lock.js";
import { removeWorktree, worktreePath } from "../git/worktree.js";
import { getIssue, editIssue } from "../github/github.js";
import { issueAgent } from "../board/board.js";
import { STATUS, NEEDS_ATTENTION, agentLabel } from "../github/labels.js";

/**
 * Abandon a stuck task: release its claim lock, prune its worktree, and return
 * the issue to `status:todo` (clearing claim/progress/agent/needs-attention
 * labels) so any agent can re-claim it.
 */
export async function abandonCommand(issueArg: string, opts: { agent?: string }): Promise<void> {
  const cwd = process.cwd();
  const cfg = loadConfig(cwd);
  resolveAgent(opts.agent, cfg); // validate the acting identity

  const number = Number(issueArg);
  if (!Number.isInteger(number)) throw new Error(`invalid issue number: ${issueArg}`);

  const issue = await getIssue(number, { cwd });
  const owner = issueAgent(issue);

  const released = await lockRelease(number, { cwd });
  const removed = await removeWorktree(worktreePath(cfg.worktreeRoot, number, cwd), { cwd });

  const removeLabels = [STATUS.claimed, STATUS.inProgress, STATUS.inReview, NEEDS_ATTENTION];
  if (owner) removeLabels.push(agentLabel(owner));
  await editIssue(number, {
    cwd,
    addLabels: [STATUS.todo],
    removeLabels,
    removeAssignees: ["@me"],
  });

  console.log(pc.green(`Abandoned #${number} — returned to ${STATUS.todo}.`));
  console.log(
    pc.dim(
      `  lock ${released ? "released" : "was not held"}; worktree ${removed ? "removed" : "not present"}.`,
    ),
  );
}
