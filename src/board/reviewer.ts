import type { OrchConfig, ReviewPolicy } from "../config.js";
import { unavailableUntil } from "./availability.js";
import { acceptedReviewers, premiumTier, type ReviewIdentity, type ReviewMode } from "./approval.js";
import { reviewIdentity } from "./review-identity.js";
import type { Issue } from "../github/github.js";

export interface ReviewerPick {
  reviewer: string;
  mode: ReviewMode;
}

/**
 * Choose who reviews a PR. Pure.
 *
 * Premium different-family review wins while an eligible harness is available. Only when none is
 * (all on usage-limit cooldown) and the policy allows it does the author's own harness
 * review - in a fresh headless session, never the one that wrote the code. Returns
 * null when nobody can review right now.
 */
export function pickReviewer(params: {
  author: string | null;
  agents: readonly string[];
  policy: ReviewPolicy;
  unavailable: ReadonlySet<string>;
  identities?: Readonly<Record<string, ReviewIdentity>>;
  authorFamily?: string;
}): ReviewerPick | null {
  const { author, agents, policy, unavailable } = params;
  const eligible = acceptedReviewers({ reviewers: agents.filter((a) => a !== author), selfReviewers: [],
    reviewMetadata: params.identities }, author, policy, params.authorFamily);
  const knownFamily = (a: string) => !params.identities || !!params.identities[a]?.family;
  const cross = eligible.find((a) => knownFamily(a) && !unavailable.has(a));
  if (cross) return { reviewer: cross, mode: "cross" };
  if (policy === "cross-or-self" && author && agents.includes(author) && knownFamily(author) && premiumTier(params.identities?.[author]?.tier) && !unavailable.has(author)) {
    return { reviewer: author, mode: "self" };
  }
  return null;
}

/**
 * Guard for recording a self-review: policy must allow it and every eligible different-family harness
 * must currently be on cooldown. This is what keeps self-review a fallback rather than
 * a way around cross-review. (A single-harness setup has no other harness, so it passes.)
 */
export function assertSelfReviewAllowed(author: string, cfg: OrchConfig, cwd: string, now: Date = new Date(), issue?: Issue): void {
  if (cfg.reviewPolicy !== "cross-or-self") {
    throw new Error(`self-review is disabled (reviewPolicy is "${cfg.reviewPolicy}").`);
  }
  const identities = issue ? Object.fromEntries(cfg.agents.map((a) => [a, reviewIdentity(a, issue, cfg)])) : undefined;
  const eligible = acceptedReviewers({ reviewers: cfg.agents.filter((a) => a !== author), selfReviewers: [], reviewMetadata: identities },
    author, cfg.reviewPolicy, issue ? reviewIdentity(author, issue, cfg, "author").family : undefined);
  const available = eligible.filter((a) => (!identities || !!identities[a]?.family) && unavailableUntil(a, cwd, now) === null);
  if (available.length > 0) {
    throw new Error(
      `self-review is only a fallback: '${available[0]}' is available, so it must review PRs authored by '${author}'.`,
    );
  }
}
