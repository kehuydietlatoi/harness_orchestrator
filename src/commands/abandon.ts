import pc from "picocolors";
import { existsSync } from "node:fs";
import { loadConfig } from "../config.js";
import { resolveAgent } from "../tasks/service.js";
import { release as lockRelease } from "../git/lock.js";
import { discardWorktree, removeWorktree, worktreePath } from "../git/worktree.js";
import { getIssue, editIssue } from "../github/github.js";
import { issueAgent } from "../board/board.js";
import { STATUS, NEEDS_ATTENTION, agentLabel } from "../github/labels.js";

/**
 * Abandon a stuck task. Safe removal is the default; retained work stops the
 * reset before ownership is released. `--discard` is the explicit destructive
 * path. Once cleanup succeeds, return the issue to `status:todo` so another
 * agent can claim it.
 */
export async function abandonCommand(
  issueArg: string,
  opts: { agent?: string; discard?: boolean },
): Promise<void> {
  const cwd = process.cwd();
  const cfg = loadConfig(cwd);
  resolveAgent(opts.agent, cfg); // validate the acting identity

  const number = Number(issueArg);
  if (!Number.isInteger(number)) throw new Error(`invalid issue number: ${issueArg}`);

  const issue = await getIssue(number, { cwd });
  const owner = issueAgent(issue);

  const path = worktreePath(cfg.worktreeRoot, number, cwd);
  const removed = opts.discard
    ? await discardWorktree(path, { cwd })
    : await removeWorktree(path, { cwd });
  if (!removed && existsSync(path)) {
    const detail = opts.discard
      ? "the explicit discard failed; its lock and issue projection were preserved"
      : "it contains recoverable or uninspectable work; inspect it, or rerun with --discard to explicitly destroy it";
    throw new Error(`worktree #${number} was preserved because ${detail}.`);
  }

  const released = await lockRelease(number, { cwd });

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
      `  lock ${released ? "released" : "was not held"}; worktree ${removed ? (opts.discard ? "discarded" : "safely removed") : "not present"}.`,
    ),
  );
}
