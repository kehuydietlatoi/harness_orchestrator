import pc from "picocolors";
import { loadConfig } from "../config.js";
import { dispatchSpecific } from "../tasks/runner.js";

/** Claim and drive one routed todo selected by issue number. */
export async function dispatchCommand(issueArg: string): Promise<void> {
  const number = Number(issueArg);
  if (!Number.isInteger(number) || number < 1) throw new Error(`invalid issue number: ${issueArg}`);

  const cwd = process.cwd();
  const summary = await dispatchSpecific(number, loadConfig(cwd), cwd);
  console.log(pc.bold(`Dispatched #${number}: ${summary.outcome}${summary.prUrl ? ` -> ${summary.prUrl}` : ""}`));
}
