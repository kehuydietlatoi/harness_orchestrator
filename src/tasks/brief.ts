import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Issue } from "../github/github.js";
import type { Worktree } from "../git/worktree.js";

/** Context for sending a changes-requested PR back to its author. */
export interface ReworkBrief {
  pr: number;
  notes: string;
  /** Local ref of the repository base branch to merge in. */
  baseRef: string;
}

/** The consistent briefing handed to whichever harness picks up a task. */
export function buildBrief(
  issue: Issue,
  worktree: Worktree,
  agent: string,
  cwd: string,
  rework?: ReworkBrief,
): string {
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
    ...(rework ? reworkSection(rework) : []),
    `## Working agreement`,
    `- Do all work inside the worktree above.`,
    `- ${memoryNote}`,
    rework
      ? `- When done: \`orch submit ${issue.number} --agent ${agent}\` — pushes to the existing PR #${rework.pr} (no new PR) and routes it back to review.`
      : `- When done: \`orch submit ${issue.number} --agent ${agent}\` — opens a PR and routes review to the other harness.`,
    ``,
  ].join("\n");
}

function reworkSection(rework: ReworkBrief): string[] {
  const base = rework.baseRef.replace(/^refs\/(heads|remotes)\//, "").replace(/^origin\//, "");
  return [
    `## Rework requested on PR #${rework.pr}`,
    `A reviewer requested changes. The worktree is on the existing PR branch; address the review notes below with new commits.`,
    `- Do not open a new PR, rebase, or force-push.`,
    `- Bring the branch up to date with base by merging it (\`git fetch origin\` then \`git merge origin/${base}\`), not rebasing, so a plain push works.`,
    ``,
    `### Review notes`,
    rework.notes || "_(the reviewer left no note)_",
    ``,
  ];
}
