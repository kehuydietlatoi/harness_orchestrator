import { resolveFamily, resolveTierModel, type OrchConfig } from "../config.js";
import type { Issue } from "../github/github.js";
import { issueEffort } from "./board.js";

/** Authors use the implementation tier; independent reviews run at least at standard. Pure. */
export function reviewIdentity(agent: string, issue: Issue, cfg: OrchConfig, purpose: "author" | "review" = "review") {
  const taskTier = issueEffort(issue, cfg.tierAliases) ?? cfg.defaultEffort ?? "lead";
  const tier = purpose === "review" && (taskTier === "free" || taskTier === "cheap") ? "standard" : taskTier;
  const model = purpose === "author" ? resolveTierModel(agent, tier, cfg, issue.labels) : cfg.adapters[agent]?.models?.[tier];
  return { tier, family: resolveFamily(agent, model, cfg), model };
}
