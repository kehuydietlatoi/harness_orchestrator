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

/** Abstract model-effort tiers assigned to tasks. */
export const EFFORT = {
  easy: "effort:easy",
  hard: "effort:hard",
} as const;

export const EFFORT_LABELS: string[] = Object.values(EFFORT);

export function effortLabel(tier: string): string {
  return `effort:${tier}`;
}

export const REVIEW_NEEDED = "review:needed";
export const NEEDS_ATTENTION = "needs-attention";

/** Provenance: the routing on this issue was chosen by the judge, not a human. */
export const ASSIGNED_BY_BRAIN = "assigned-by:brain";

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
  { name: EFFORT.easy, color: "c2e0c6", description: "Use the agent's easy model tier" },
  { name: EFFORT.hard, color: "f9d0c4", description: "Use the agent's hard model tier" },
  { name: ASSIGNED_BY_BRAIN, color: "bfd4f2", description: "Routing chosen by the judge, not a human" },
];

const LABEL_BY_NAME = new Map(LABELS.map((l) => [l.name, l]));

/**
 * Resolve label names to their canonical `GhLabel` definitions (deduplicated),
 * defaulting the cosmetics for a name outside the canonical set — e.g. a newly
 * configured agent's `agent:<name>`. Pure; used to ensure routing labels exist
 * before they are applied, so a repo initialised before the label set grew does
 * not fail the write. See the "label schema-drift" note in WORKFLOW.md.
 */
export function labelDefs(names: readonly string[]): GhLabel[] {
  const seen = new Set<string>();
  const out: GhLabel[] = [];
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(LABEL_BY_NAME.get(name) ?? { name, color: "ededed", description: "" });
  }
  return out;
}
