import pc from "picocolors";
import { loadConfig } from "../config.js";
import { listIssues } from "../github/github.js";
import { issueStatus, issueAgent } from "../board/board.js";
import { STATUS_LABELS } from "../github/labels.js";

export async function boardCommand(): Promise<void> {
  const cwd = process.cwd();
  loadConfig(cwd); // ensure we're in an initialised repo

  const issues = (await listIssues({ cwd, state: "all" })).sort((a, b) => a.number - b.number);

  const groups = new Map<string, string[]>();
  for (const s of STATUS_LABELS) groups.set(s, []);
  for (const i of issues) {
    const s = issueStatus(i);
    const agent = issueAgent(i);
    const line = `  #${i.number} ${i.title}${agent ? pc.dim(` [${agent}]`) : ""}`;
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s)!.push(line);
  }

  console.log(pc.bold("orch board\n"));
  let printed = false;
  for (const [status, lines] of groups) {
    if (!lines.length) continue;
    printed = true;
    console.log(pc.bold(status));
    lines.forEach((l) => console.log(l));
    console.log("");
  }
  if (!printed) console.log(pc.dim("  (no issues yet)"));
}
