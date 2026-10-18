import * as gh from "./github.js";
import type { ChecksState, Issue, IssueComment, Mergeability, Pr, PrReview } from "./github.js";

/** GitHub operations used by the autopilot loop. */
export interface Board {
  listIssues(opts?: { cwd?: string; state?: "open" | "closed" | "all" }): Promise<Issue[]>;
  listOpenPrs(opts?: { cwd?: string }): Promise<Pr[]>;
  listPrReviews(number: number, opts?: { cwd?: string }): Promise<PrReview[]>;
  listPrComments(number: number, opts?: { cwd?: string }): Promise<IssueComment[]>;
  prChecksState(number: number, opts?: { cwd?: string; strict?: boolean }): Promise<ChecksState>;
  prMergeability(number: number, opts?: { cwd?: string }): Promise<Mergeability>;
  editIssue(number: number, opts?: {
    cwd?: string;
    addLabels?: string[];
    removeLabels?: string[];
    addAssignees?: string[];
    removeAssignees?: string[];
  }): Promise<void>;
  commentOnPr(number: number, body: string, opts?: { cwd?: string }): Promise<void>;
}

/** Production board: retain the existing GitHub functions' behavior and defaults. */
export const ghBoard: Board = {
  listIssues: (opts) => gh.listIssues(opts),
  listOpenPrs: (opts) => gh.listOpenPrs(opts),
  listPrReviews: (number, opts) => gh.listPrReviews(number, opts),
  listPrComments: (number, opts) => gh.listPrComments(number, opts),
  prChecksState: (number, opts) => gh.prChecksState(number, opts),
  prMergeability: (number, opts) => gh.prMergeability(number, opts),
  editIssue: (number, opts) => gh.editIssue(number, opts),
  commentOnPr: (number, body, opts) => gh.commentOnPr(number, body, opts),
};
