# ADR-0003: Cross-review is a process guarantee

- Status: Accepted
- Date: 2026-08-21

## Context

Claude Code and Codex run on the same machine under one GitHub identity. GitHub's
native review author therefore cannot represent which harness performed a
review, so `orch` records agent-level approval with `reviewed-by:<agent>` issue
labels.

The merge gate checks that a reviewer label names a configured agent different
from the issue's author label. `orch review-approve --agent <agent>` rejects a
matching author label, and each dispatcher is expected to pass only its own
identity. However, `--agent` is a caller assertion, not an authenticated
identity. Either harness, or any script with the shared GitHub credentials, can
claim the other agent's name and apply a label that satisfies the gate.

The gate therefore prevents accidental same-label self-review, but it cannot
prove that another harness actually performed the review.

## Decision

Describe cross-review as a **process guarantee**, not as structurally impossible
self-approval. The enforced invariant is:

```text
author-label != reviewer-label
```

We trust dispatchers and operators to supply their own configured agent identity.
The current gate is useful workflow policy, but it is not caller authentication
or a security boundary.

Real authenticity requires an identity the approving process cannot forge. A
future design should give each agent separate credentials (for example, distinct
GitHub Apps or bot users) and derive the reviewer from the authenticated
principal instead of `--agent`. Alternatively, each agent can sign an approval
attestation that binds its identity to the PR number and reviewed head SHA; the
merge gate must verify that signature against a per-agent public key. Either
approach also requires isolating credentials or private keys so one harness
cannot use the other's identity.

## Consequences

- Documentation no longer promises caller authenticity that the implementation
  cannot establish.
- The existing gate continues to catch accidental self-review and incorrect
  reviewer routing without changing the current single-machine workflow.
- A malicious or misconfigured process with shared credentials can still forge
  cross-review until per-agent identity and credential isolation are implemented.
- Enforcing authentic reviewers later will require credential provisioning or
  key management, identity-to-agent mapping, and migration from label-only
  approvals to verified principals or attestations.

## Review backlog

| Finding | Status | Follow-up |
|---|---|---|
| Claim lock leaked after a failed or no-commit harness run | Resolved | Failure paths now release the lock and prune the task worktree; preserve this lifecycle for every new terminal state. |
| Worktree was pruned before the PR merge completed | Resolved | Merge now completes before cleanup, preserving the branch/worktree when merge fails. |
| N+1 `gh` lookups while evaluating issue eligibility and review queues | Open | Fetch issue/PR metadata in bulk and evaluate candidates from the resulting snapshot. |
| Adapter `runReview` and `healthCheck` seams are implemented but unwired | Open | Invoke health checks before dispatch and either wire automated review dispatch or remove the unused seam. |
| `orch run` is described as a daemon but drains the currently eligible queue once and exits | Open | Either add polling/wake-up behavior or consistently document and name it as a one-shot drainer. |
