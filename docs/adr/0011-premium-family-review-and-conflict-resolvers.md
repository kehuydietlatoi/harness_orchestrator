# ADR-0011: Premium different-family approvals and configurable conflict resolvers

Accepted, 2026-10-18. Amends [ADR-0008](0008-self-review-fallback.md).

OpenCode separates the harness from the model provider, and free/cheap implementation
models must not authorize merges. Approval therefore requires a reviewer at tier
`standard` or `lead`, from a different family than the author. Two harnesses using
Anthropic models do not provide independent family review. `acceptedReviewers` is
the shared policy for the merge gate, autonomous loop, queue, repair, and board.

The existing head-bound `orch-review:v1` marker gains `tier` and `family`. Automated
and manual review writers resolve these from the review model. Automated reviews
raise free/cheap implementation tiers to standard for the review session; the
author's family still comes from the implementation tier. Model-level family wins
over the adapter default, using the family contract from #120. New automated
reviewers without a known family are ineligible. Existing records without metadata
remain premium with the harness default family (Claude: anthropic; Codex: openai;
other legacy harnesses retain their own identity), preserving existing cross approvals.
The record's metadata survives later changes to reviewer model configuration.

`reviewPolicy` now defaults to `cross`. Teams must explicitly choose
`cross-or-self` to permit a fresh author session, marked `mode: "self"`, when
no eligible different-family reviewer is available. This exception still requires
a premium tier; free/cheap records never count, including self records. Availability
and read-only checkout safeguards from ADR-0008 continue to apply.

Conflict resolution uses ordered `conflictResolvers: string[]`, defaulting to
`["claude", "<author>"]`. The literal `<author>` expands for each task. The first
configured harness that is available and allowed by the task role resolves the
conflict; an empty list disables automatic resolution. This preserves today's
preference while allowing teams to select other resolvers without changing code.

Protected-path lead review and reviewer blinding are deferred to later phases.
