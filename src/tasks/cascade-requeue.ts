import type { CascadeRoute } from "../config.js";
import { editIssue, ensureLabels, type Issue } from "../github/github.js";
import { labelDefs } from "../github/labels.js";

/** Shared routing projection for implement requeues and PR fix cascades. */
export function cascadeLabels(issue: Issue, route: CascadeRoute): { addLabels: string[]; removeLabels: string[] } {
  const addLabels = [`agent:${route.agent}`, `effort:${route.tier}`, ...(route.model ? [`model:${route.model}`] : [])];
  return { addLabels, removeLabels: issue.labels.filter((label) => /^(agent|effort|model):/.test(label) && !addLabels.includes(label)) };
}

/** An open PR keeps its claim and worktree; only its writable route changes. */
export async function cascadeRequeue(issue: Issue, route: CascadeRoute, cwd: string): Promise<void> {
  const labels = cascadeLabels(issue, route);
  await ensureLabels(labelDefs(labels.addLabels), cwd);
  await editIssue(issue.number, { cwd, ...labels });
}
