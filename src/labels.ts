import type { GhLabel } from "./github.js";

/** Status lifecycle label names. */
export const STATUS = {
  todo: "status:todo",
  claimed: "status:claimed",
  inProgress: "status:in-progress",
  inReview: "status:in-review",
  blocked: "status:blocked",
  done: "status:done",
} as const;

export const STATUS_LABELS: string[] = Object.values(STATUS);

export const REVIEW_NEEDED = "review:needed";
export const NEEDS_ATTENTION = "needs-attention";

export function agentLabel(agent: string): string {
  return `agent:${agent}`;
}

export const REVIEWED_BY_PREFIX = "reviewed-by:";

export function reviewedByLabel(agent: string): string {
  return `${REVIEWED_BY_PREFIX}${agent}`;
}

/** Canonical label set the orchestrator relies on. Created by `orch init`. */
export const LABELS: GhLabel[] = [
  { name: STATUS.todo, color: "ededed", description: "Ready to be claimed" },
  { name: STATUS.claimed, color: "fbca04", description: "Claimed by an agent" },
  { name: STATUS.inProgress, color: "0e8a16", description: "Agent is working" },
  { name: STATUS.inReview, color: "1d76db", description: "PR open, awaiting cross-review" },
  { name: STATUS.blocked, color: "b60205", description: "Blocked by a dependency" },
  { name: STATUS.done, color: "5319e7", description: "Merged" },
  { name: "agent:claude", color: "d4a5ff", description: "Owned by Claude Code" },
  { name: "agent:codex", color: "a5d4ff", description: "Owned by Codex" },
  { name: REVIEW_NEEDED, color: "e99695", description: "Awaiting review by the other harness" },
  { name: "reviewed-by:claude", color: "c5def5", description: "Cross-reviewed and approved by Claude" },
  { name: "reviewed-by:codex", color: "c5def5", description: "Cross-reviewed and approved by Codex" },
  { name: NEEDS_ATTENTION, color: "d93f0b", description: "Failed run — needs a human" },
];
