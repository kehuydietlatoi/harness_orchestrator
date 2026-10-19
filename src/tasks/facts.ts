import type { TaskFacts } from "./lifecycle.js";
import type { Pr, PrReview } from "../github/github.js";
import { reviewState } from "../board/approval.js";
import { UnknownModelProjection, resolveTierModel, type OrchConfig } from "../config.js";
import { issueAgent, issueEffort } from "../board/board.js";
import type { Issue } from "../github/github.js";

/** Observe stale projections without weakening the strict dispatch resolver. Pure. */
export function modelProjectionFact(issue: Issue, cfg: OrchConfig, agent = issueAgent(issue)) {
  if (!agent) return undefined;
  try {
    resolveTierModel(agent, issueEffort(issue, cfg.tierAliases) ?? cfg.defaultEffort ?? "lead", cfg, issue.labels);
    return undefined;
  } catch (error) {
    if (!(error instanceof UnknownModelProjection)) throw error;
    return { label: error.label, detail: error.message };
  }
}

export function reviewFact(pr: Pr | undefined, reviews: readonly PrReview[]) {
  return reviewState(pr?.state === "OPEN" ? reviews : [], pr?.number ?? 0, pr?.headSha ?? "");
}

export function prFact(prs: readonly { state: string }[]): TaskFacts["pr"] {
  if (prs.some((pr) => pr.state === "OPEN")) return "open";
  if (prs.some((pr) => pr.state === "MERGED")) return "merged";
  if (prs.some((pr) => pr.state === "CLOSED")) return "closed";
  return "none";
}

export function telemetryFact(records: readonly { issue: number; outcome?: string }[], issue: number): TaskFacts["telemetry"] {
  const latest = records.filter((r) => r.issue === issue).at(-1);
  switch (latest?.outcome) {
    case "submitted": case "auto-submitted": return "submitted";
    case "failed": case "budget-spent": return "failed";
    case "needs-attention": case "no-commits": return "no-commits";
    default: return "none";
  }
}
