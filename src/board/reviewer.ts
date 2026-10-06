import type { OrchConfig, ReviewPolicy } from "../config.js";
import { unavailableUntil } from "./availability.js";
import type { ReviewMode } from "./approval.js";

export interface ReviewerPick {
  reviewer: string;
  mode: ReviewMode;
}

/**
 * Choose who reviews a PR. Pure.
 *
 * Cross-review always wins while any other harness is available. Only when none is
 * (all on usage-limit cooldown) and the policy allows it does the author's own harness
 * review - in a fresh headless session, never the one that wrote the code. Returns
 * null when nobody can review right now.
 */
export function pickReviewer(params: {
  author: string | null;
  agents: readonly string[];
  policy: ReviewPolicy;
  unavailable: ReadonlySet<string>;
}): ReviewerPick | null {
  const { author, agents, policy, unavailable } = params;
  const cross = agents.find((a) => a !== author && !unavailable.has(a));
  if (cross) return { reviewer: cross, mode: "cross" };
  if (policy === "cross-or-self" && author && agents.includes(author) && !unavailable.has(author)) {
    return { reviewer: author, mode: "self" };
  }
  return null;
}

/**
 * Guard for recording a self-review: policy must allow it and every *other* harness
 * must currently be on cooldown. This is what keeps self-review a fallback rather than
 * a way around cross-review. (A single-harness setup has no other harness, so it passes.)
 */
export function assertSelfReviewAllowed(author: string, cfg: OrchConfig, cwd: string, now: Date = new Date()): void {
  if (cfg.reviewPolicy !== "cross-or-self") {
    throw new Error(`self-review is disabled (reviewPolicy is "${cfg.reviewPolicy}").`);
  }
  const available = cfg.agents.filter((a) => a !== author && unavailableUntil(a, cwd, now) === null);
  if (available.length > 0) {
    throw new Error(
      `self-review is only a fallback: '${available[0]}' is available, so it must review PRs authored by '${author}'.`,
    );
  }
}
