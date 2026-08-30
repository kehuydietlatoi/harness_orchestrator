import pc from "picocolors";
import { loadConfig } from "../config.js";
import { resolveAgent, claimNext } from "../tasks/service.js";
import { buildBrief } from "../tasks/brief.js";
import { reportCycles } from "./cycle-report.js";

export async function nextCommand(opts: { agent?: string }): Promise<void> {
  const cwd = process.cwd();
  const cfg = loadConfig(cwd);
  const agent = resolveAgent(opts.agent, cfg);

  const task = await claimNext(agent, cfg, cwd);
  if (!task) {
    // Warn-and-continue: nothing was claimable. If a dependency cycle exists it is
    // the likely reason, so name it instead of the misleading "all done/blocked".
    const cycles = await reportCycles(cwd);
    if (cycles === 0) {
      console.log(pc.yellow("No eligible issues to claim (all done, claimed, or blocked)."));
    }
    process.exitCode = 3;
    return;
  }
  console.log(pc.green(`Claimed #${task.issue.number} as '${agent}'.\n`));
  console.log(buildBrief(task.issue, task.worktree, agent, cwd));
}
