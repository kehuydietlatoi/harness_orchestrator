import pc from "picocolors";
import { loadConfig } from "../config.js";
import { resolveAgent, submit } from "../service.js";

export async function submitCommand(issueArg: string, opts: { agent?: string }): Promise<void> {
  const cwd = process.cwd();
  const cfg = loadConfig(cwd);
  const agent = resolveAgent(opts.agent, cfg);

  const number = Number(issueArg);
  if (!Number.isInteger(number)) throw new Error(`invalid issue number: ${issueArg}`);

  const url = await submit(number, agent, cfg, cwd);
  const reviewer = cfg.agents.find((a) => a !== agent) ?? "the other harness";
  console.log(pc.green(`Submitted #${number}.`));
  console.log(`PR: ${url}`);
  console.log(pc.dim(`Review routed to '${reviewer}'. Merge is gated on their approval.`));
}
