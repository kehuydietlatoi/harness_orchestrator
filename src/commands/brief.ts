import { loadConfig } from "../config.js";
import { resolveAgent } from "../service.js";
import { getIssue } from "../github.js";
import { worktreePath, branchName, slugify } from "../worktree.js";
import { buildBrief } from "../brief.js";

export async function briefCommand(issueArg: string, opts: { agent?: string }): Promise<void> {
  const cwd = process.cwd();
  const cfg = loadConfig(cwd);
  const agent = resolveAgent(opts.agent, cfg);

  const n = Number(issueArg);
  if (!Number.isInteger(n)) throw new Error(`invalid issue number: ${issueArg}`);

  const issue = await getIssue(n, { cwd });
  const wt = {
    path: worktreePath(cfg.worktreeRoot, n, cwd),
    branch: branchName(n, slugify(issue.title)),
  };
  console.log(buildBrief(issue, wt, agent, cwd));
}
