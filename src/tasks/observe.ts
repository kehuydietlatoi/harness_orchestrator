import {
  listIssues,
  listOpenPrs,
  listPrReviews,
  prChecksState,
  prMergeability,
  type Issue,
  type Pr,
  type PrReview,
} from "../github/github.js";
import { NEEDS_ATTENTION } from "../github/labels.js";
import { countChangeRequests, latestChangeRequestNotes, reviewState } from "../board/approval.js";
import { byNumber, issueAgent } from "../board/board.js";
import { prIssueNumber, reviewSatisfied } from "../board/review.js";
import type { OrchConfig } from "../config.js";
import { log } from "../util/log.js";
import { fixRoundsFor, readEvents } from "./events.js";
import { decideStep, type ChecksFact, type MergeableFact, type Step, type StepFacts } from "./steps.js";

/** Everything the loop knows about one in-flight task, observed fresh from GitHub. */
export interface TaskObservation {
  issue: Issue;
  /** The harness that wrote the change (`agent:` label). */
  author: string;
  pr: Pr;
  reviews: PrReview[];
  facts: StepFacts;
  step: Step;
  /** Reviewer's notes when the latest decision on the current head requests changes. */
  feedback: string | null;
}

/**
 * Pure assembly of step facts from raw observations, so the mapping from GitHub's shapes to
 * the decision table is testable without any I/O.
 */
export function assembleFacts(params: {
  issue: Issue;
  author: string;
  pr: Pr;
  reviews: readonly PrReview[];
  checks: ChecksFact;
  mergeable: MergeableFact;
  localRounds: number;
  cfg: OrchConfig;
}): StepFacts {
  const { issue, author, pr, reviews, checks, mergeable, localRounds, cfg } = params;
  const rs = reviewState(reviews, pr.number, pr.headSha);
  const approved =
    !cfg.requireCrossReview ||
    reviewSatisfied({
      author,
      reviewers: rs.reviewers,
      selfReviewers: rs.selfReviewers,
      reviewPolicy: cfg.reviewPolicy,
      agents: cfg.agents,
    });
  return {
    attention: issue.labels.includes(NEEDS_ATTENTION),
    pr: { number: pr.number, head: pr.headSha, checks, mergeable },
    review: { approved, changesRequested: rs.changesRequested },
    // The PR's own history is durable; the local event log can only add to it.
    rounds: Math.max(countChangeRequests(reviews, pr.number), localRounds),
    maxRounds: cfg.maxReviewRounds,
    requireHumanMerge: cfg.requireHumanMerge,
  };
}

/**
 * Observe every open task PR once. A PR that cannot be observed this pass is skipped with a
 * warning (no decision is better than a decision from partial facts); the next pass retries.
 */
export async function observeTasks(cfg: OrchConfig, cwd: string): Promise<TaskObservation[]> {
  const [issues, prs] = await Promise.all([listIssues({ cwd, state: "open" }), listOpenPrs({ cwd })]);
  const open = byNumber(issues);
  const events = readEvents(cwd);
  const out: TaskObservation[] = [];

  for (const pr of prs) {
    const n = prIssueNumber(pr);
    const issue = n === null ? undefined : open.get(n);
    if (!issue || n === null) continue;
    const author = issueAgent(issue);
    if (!author || !cfg.agents.includes(author)) continue; // not an orch-owned task
    try {
      const [reviews, checks, mergeable] = await Promise.all([
        listPrReviews(pr.number, { cwd }),
        prChecksState(pr.number, { cwd }),
        prMergeability(pr.number, { cwd }),
      ]);
      const facts = assembleFacts({
        issue, author, pr, reviews, checks, mergeable, localRounds: fixRoundsFor(events, n), cfg,
      });
      out.push({
        issue, author, pr, reviews, facts, step: decideStep(facts),
        feedback: latestChangeRequestNotes(reviews, pr.number, pr.headSha),
      });
    } catch (error) {
      log.warn(`could not observe PR #${pr.number}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return out;
}
