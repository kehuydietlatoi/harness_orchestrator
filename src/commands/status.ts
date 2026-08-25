import pc from "picocolors";
import { loadConfig } from "../config.js";
import { resolveAgent } from "../tasks/service.js";
import { listIssues } from "../github/github.js";
import { issueStatus, issueAgent, eligibleIssues } from "../board/board.js";

function section(title: string, lines: string[]): void {
  console.log(pc.bold(title));
  if (!lines.length) console.log(pc.dim("  (none)"));
  else lines.forEach((l) => console.log("  " + l));
  console.log("");
}

export async function statusCommand(opts: { agent?: string }): Promise<void> {
  const cwd = process.cwd();
  const cfg = loadConfig(cwd);
  const agent = resolveAgent(opts.agent, cfg);

  const issues = await listIssues({ cwd, state: "open" });
  const mine = issues.filter((i) => issueAgent(i) === agent);
  const others = issues.filter((i) => {
    const a = issueAgent(i);
    return a !== null && a !== agent;
  });
  const eligible = await eligibleIssues(cwd);

  console.log(pc.bold(`orch status — agent '${agent}'\n`));
  section(
    "Working on (you)",
    mine.map((i) => `#${i.number} ${i.title} ${pc.dim(issueStatus(i))}`),
  );
  section(
    "Up next (eligible)",
    eligible.map((i) => `#${i.number} ${i.title}`),
  );
  section(
    "Other agents",
    others.map((i) => `#${i.number} ${i.title} ${pc.dim(`[${issueAgent(i)}] ${issueStatus(i)}`)}`),
  );
}
