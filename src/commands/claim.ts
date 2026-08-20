import pc from "picocolors";
import { loadConfig } from "../config.js";
import { resolveAgent, claimSpecific } from "../service.js";
import { buildBrief } from "../brief.js";

export async function claimCommand(issueArg: string, opts: { agent?: string }): Promise<void> {
  const cwd = process.cwd();
  const cfg = loadConfig(cwd);
  const agent = resolveAgent(opts.agent, cfg);

  const number = Number(issueArg);
  if (!Number.isInteger(number)) throw new Error(`invalid issue number: ${issueArg}`);

  const task = await claimSpecific(number, agent, cfg, cwd);
  console.log(pc.green(`Claimed #${number} as '${agent}'.\n`));
  console.log(buildBrief(task.issue, task.worktree, agent, cwd));
}
