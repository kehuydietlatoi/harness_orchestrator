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
import { answeredChangeRequestRounds, latestChangeRequestNotes, reviewState } from "../board/approval.js";
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
    // Rounds already *spent*: the distinct earlier heads that drew a change request (each was answered by
    // a fix, since the head moved on). Whatever is pending on the current head is not spent, and several
    // requests on one unchanged head are still a single fix, so a budget of N allows exactly N fixes.
    // The local event log can only add to this.
    rounds: Math.max(answeredChangeRequestRounds(reviews, pr.number, pr.headSha), localRounds),
    maxRounds: cfg.maxReviewRounds,
    requireHumanMerge: cfg.requireHumanMerge,
  };
}

/** One pass over the board: the tasks we could read, the PRs we could not, and the issues we must not touch. */
export interface Observation {
  tasks: TaskObservation[];
  /** PR numbers that could not be read this pass. Callers must treat them as unknown, never as done. */
  unobserved: number[];
  /**
   * Issues with more than one open PR. Which one is "the" task PR is a human decision, so none of them is
   * observed or driven. Decided from the complete open-PR list *before* any per-PR lookup, so a PR that
   * would have failed to load still counts: otherwise its readable twin would look unique and could merge.
   */
  ambiguous: Array<{ issue: number; prs: number[] }>;
}

/**
 * Observe every open task PR once. A PR that cannot be observed gets no decision (a decision from
 * partial facts is worse than none) but is reported in `unobserved`, so the caller keeps polling
 * instead of concluding that nothing is left to do.
 */
export async function observeTasks(cfg: OrchConfig, cwd: string): Promise<Observation> {
  const [issues, prs] = await Promise.all([listIssues({ cwd, state: "open" }), listOpenPrs({ cwd })]);
  const open = byNumber(issues);
  const events = readEvents(cwd);
  const out: TaskObservation[] = [];
  const unobserved: number[] = [];

  // Group the orch-owned PRs by issue first, from the full list, so ambiguity never depends on what loads.
  const owned = new Map<number, { issue: Issue; author: string; prs: Pr[] }>();
  for (const pr of prs) {
    const n = prIssueNumber(pr);
    const issue = n === null ? undefined : open.get(n);
    if (!issue || n === null) continue;
    const author = issueAgent(issue);
    if (!author || !cfg.agents.includes(author)) continue; // not an orch-owned task
    const entry = owned.get(n) ?? { issue, author, prs: [] };
    entry.prs.push(pr);
    owned.set(n, entry);
  }

  const ambiguous: Observation["ambiguous"] = [];
  for (const [n, { issue, author, prs: candidates }] of owned) {
    if (candidates.length > 1) {
      ambiguous.push({ issue: n, prs: candidates.map((p) => p.number).sort((a, b) => a - b) });
      continue;
    }
    const pr = candidates[0];
    try {
      const [reviews, checks, mergeable] = await Promise.all([
        listPrReviews(pr.number, { cwd }),
        prChecksState(pr.number, { cwd, strict: true }), // a failed lookup must be 'unobserved', never 'red'
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
      unobserved.push(pr.number);
      log.warn(`could not observe PR #${pr.number}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { tasks: out, unobserved, ambiguous };
}
