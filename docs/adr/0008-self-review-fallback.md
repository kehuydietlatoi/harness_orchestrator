# ADR-0008: Self-review as a usage-limit fallback

- Status: Accepted
- Date: 2026-10-06

## Context

ADR-0003 makes cross-review a process guarantee: the reviewer must be a configured
harness other than the author. In practice each harness runs on a metered subscription.
When one runs out of usage (Codex's `You've hit your usage limit ... try again at 4:33 PM`;
Claude's rejected `rate_limit_event`), every PR authored by the other harness is blocked at
the merge gate until the limit resets, even though the exhausted harness is the only thing
missing. Issue #71 was interrupted exactly this way.

## Decision

1. **Detect exhaustion.** `detectUsageLimit` (pure) recognises error-shaped events only
   (`error`, `turn.failed`, a non-allowed `rate_limit_event`, an `is_error` result), never
   ordinary assistant text. A hit puts the harness on a cooldown stored in
   `~/.orch/<project>/availability.json`. The cooldown is runtime state, not lifecycle truth.
2. **Review headlessly and read-only.** `orch review-run` runs the reviewer through
   `runHeadless({readOnly: true})`: Claude gets `Read,Grep,Glob` with Edit/Write/Bash explicitly
   denied; Codex runs in `-s read-only` without auto-approval. The reviewer must end with a JSON
   verdict; anything malformed records nothing (fail closed). The verdict is bound to the head
   that was read and is refused if the PR moved.
3. **Fall back, never replace.** `pickReviewer` prefers any available other harness. Only if none
   is available, and `reviewPolicy` is `cross-or-self` (default), does the author's harness review
   in a brand-new session. The record is marked `mode: "self"`.
4. **Gate.** The gate accepts the author's approval only under `cross-or-self` *and* when the record
   is marked self. Writing a self record is refused unless every other harness is currently on
   cooldown, so self-review cannot be used to skip an available cross-reviewer.

`reviewPolicy: "cross"` restores the strict ADR-0003 behaviour.

## Consequences

- A usage limit delays work instead of blocking it indefinitely.
- A self-review is weaker than a cross-review (same model family, same blind spots). It is
  visible: records carry `mode: "self"` and `orch review-run` says so. Teams that disagree set
  `reviewPolicy: "cross"` or `requireHumanMerge: true`.
- Like ADR-0003, this is a process guarantee, not authentication: the `mode` mark and the
  cooldown are caller-supplied process state under one shared identity.
- Reviewer sessions are fresh by construction (a new process per review), so no author context
  leaks into the review. Resuming the *author's* session after a review is separate work.
- The verdict is recorded against the PR head SHA, so the reviewer reads a throwaway detached
  checkout of exactly that commit (`prepareReviewCheckout`), created before the run and removed
  after it. The author's worktree (possibly ahead, behind, dirty or on another branch) and the
  repository checkout are never used, and if no exact-head checkout can be made the review fails
  closed with nothing recorded.
- A harness that is paused is skipped by the dispatcher; its in-flight failed task still lands in
  `needs-attention` and needs `orch repair`/re-dispatch after the reset (automatic requeue is
  future work).
