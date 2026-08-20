import pc from "picocolors";
import { loadConfig } from "../config.js";
import { resolveAgent, claimNext } from "../service.js";
import { buildBrief } from "../brief.js";

export async function nextCommand(opts: { agent?: string }): Promise<void> {
  const cwd = process.cwd();
  const cfg = loadConfig(cwd);
  const agent = resolveAgent(opts.agent, cfg);

  const task = await claimNext(agent, cfg, cwd);
  if (!task) {
    console.log(pc.yellow("No eligible issues to claim (all done, claimed, or blocked)."));
    process.exitCode = 3;
    return;
  }
  console.log(pc.green(`Claimed #${task.issue.number} as '${agent}'.\n`));
  console.log(buildBrief(task.issue, task.worktree, agent, cwd));
}
