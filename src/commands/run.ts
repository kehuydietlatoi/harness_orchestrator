import pc from "picocolors";
import { loadConfig } from "../config.js";
import { resolveAgent } from "../tasks/service.js";
import { runLoop } from "../tasks/runner.js";
import { reportCycles } from "./cycle-report.js";

export async function runCommand(opts: {
  agent?: string;
  max?: string;
  once?: boolean;
}): Promise<void> {
  const cwd = process.cwd();
  const cfg = loadConfig(cwd);
  const agent = resolveAgent(opts.agent, cfg);
  const max = opts.max ? Number(opts.max) : undefined;

  console.log(
    pc.bold(`orch run — agent '${agent}'`) +
      pc.dim(opts.once ? " (single task)" : ` (max ${max ?? cfg.maxConcurrent} concurrent)`),
  );

  const summaries = await runLoop(agent, cfg, cwd, { max, once: opts.once });

  console.log("");
  if (!summaries.length) {
    // Name a dependency cycle as the cause when nothing ran, rather than implying
    // the board is simply empty.
    const cycles = await reportCycles(cwd);
    if (cycles === 0) console.log(pc.yellow("No eligible tasks to run."));
    return;
  }
  console.log(pc.bold(`Processed ${summaries.length} task(s):`));
  for (const s of summaries) {
    console.log(`  #${s.issue}: ${s.outcome}${s.prUrl ? " -> " + s.prUrl : ""}`);
  }
}
