import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Issue } from "../github/github.js";
import type { Worktree } from "../git/worktree.js";

/** The consistent briefing handed to whichever harness picks up a task. */
export function buildBrief(issue: Issue, worktree: Worktree, agent: string, cwd: string): string {
  const hasMemory = existsSync(resolve(cwd, "AGENTS.md"));
  const memoryNote = hasMemory
    ? "Read AGENTS.md at the repo root before starting; record durable facts there (not in native memory)."
    : "(no AGENTS.md found — run `orch init`)";
  return [
    `# Task #${issue.number}: ${issue.title}`,
    ``,
    `Agent:    ${agent}`,
    `Worktree: ${worktree.path}`,
    `Branch:   ${worktree.branch}`,
    ``,
    `## Spec`,
    issue.body.trim() || "_(no description)_",
    ``,
    `## Working agreement`,
    `- Do all work inside the worktree above.`,
    `- ${memoryNote}`,
    `- When done: \`orch submit ${issue.number} --agent ${agent}\` — opens a PR and routes review to the other harness.`,
    ``,
  ].join("\n");
}
