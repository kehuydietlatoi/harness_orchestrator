import type { Issue, Pr } from "../github/github.js";

/** Rules shared by every follow-up run: orch, not the agent, owns pushing and routing. */
const FOLLOW_UP_RULES = [
  "- Work only inside the worktree above, on the branch that is already checked out.",
  "- Make the smallest change that fully addresses the above; do not broaden scope.",
  "- Run the project's tests before you finish, and fix anything you broke.",
  "- Commit your work in the worktree with a clear message.",
  "- Do NOT push, open or edit a pull request, or run `orch submit`: orch pushes your commits and routes the re-review itself.",
];

/**
 * Prompt for the author's follow-up run after review feedback or a red CI. `resumed` says
 * whether this continues the author's own conversation; a cold start must re-read the spec
 * and the diff because nothing is remembered.
 */
export function formatFixPrompt(params: {
  issue: Pick<Issue, "number" | "title" | "body">;
  pr: Pick<Pr, "number" | "headRefName">;
  worktree: string;
  reason: "review" | "ci";
  notes: string | null;
  failingChecks: readonly string[];
  resumed: boolean;
  baseName: string;
}): string {
  const { issue, pr, worktree, reason, notes, failingChecks, resumed, baseName } = params;
  const why =
    reason === "review"
      ? ["A reviewer requested changes on your pull request:", "", notes?.trim() || "(the reviewer left no notes - re-read the diff critically)"]
      : [
          "Your pull request's CI is failing.",
          failingChecks.length > 0 ? `Failing checks: ${failingChecks.join(", ")}` : "The failing checks could not be listed.",
          "Reproduce the failure locally, find the root cause, and fix it (do not weaken or skip the check).",
        ];
  return [
    `# Follow-up on PR #${pr.number} for task #${issue.number}: ${issue.title}`,
    "",
    `Worktree: ${worktree}`,
    `Branch:   ${pr.headRefName}`,
    "",
    resumed
      ? "You wrote this change earlier in this conversation."
      : `A previous session wrote this change and its memory is gone: read the spec below and \`git diff ${baseName}...HEAD\` before editing. The worktree may hold uncommitted leftovers from an interrupted attempt.`,
    "",
    "## Why you are back",
    ...why,
    "",
    ...(resumed ? [] : ["## Original spec", issue.body.trim() || "_(no description)_", ""]),
    "## Rules",
    ...FOLLOW_UP_RULES,
    "",
  ].join("\n");
}

/** Prompt for the run that merges the moved base branch into a conflicting PR branch. */
export function formatConflictPrompt(params: {
  issue: Pick<Issue, "number" | "title" | "body">;
  pr: Pick<Pr, "number" | "headRefName">;
  worktree: string;
  baseName: string;
}): string {
  const { issue, pr, worktree, baseName } = params;
  return [
    `# Resolve merge conflicts on PR #${pr.number} for task #${issue.number}: ${issue.title}`,
    "",
    `Worktree: ${worktree}`,
    `Branch:   ${pr.headRefName}`,
    "",
    `\`${baseName}\` moved on and this branch now conflicts with it. orch has already fetched \`origin/${baseName}\`.`,
    "",
    "## Steps",
    `1. \`git merge origin/${baseName}\` (a merge, not a rebase - history must not be rewritten).`,
    "2. Resolve every conflict so that BOTH sides' intent survives: this task's change and whatever just landed on the base. Read both before choosing; never just take one side.",
    "3. Run the project's tests and fix anything the merge broke.",
    "4. Commit the merge.",
    "",
    "## Task spec (for intent)",
    issue.body.trim() || "_(no description)_",
    "",
    "## Rules",
    ...FOLLOW_UP_RULES.filter((rule) => !rule.startsWith("- Make the smallest")),
    "- Never force-push or rewrite history.",
    "",
  ].join("\n");
}
