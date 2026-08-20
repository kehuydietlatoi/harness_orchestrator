# ADR-0002: Atomic task-claim via a git ref mutex

- Status: Accepted
- Date: 2026-08-20

## Context

Parallel agents must never both start the same ticket. We need an **atomic
compare-and-set** "claim this task" primitive. Options considered:

1. **GitHub issue assignee** — not atomic; GitHub allows multiple assignees, and a
   read-then-assign has a race window.
2. **`gh api POST /git/refs`** — creating a GitHub ref returns 201 (created) or 422
   (already exists): a real create-only CAS, but requires a network round-trip and
   only matters when agents live on different clones.
3. **Local git ref via `git update-ref --stdin` `create`** — atomically fails if the
   ref already exists, entirely local.

## Decision

Use option 3: claim = create `refs/orch/lock/issue-<n>` with the `create` verb.
Both harnesses run on the **same machine against the same repository**, so a local
ref is a sound mutex, and refs outside `refs/worktree/*` are shared across all
worktrees. No network, no daemon.

## Consequences

- Exactly one racer wins a given issue; losers get a clean failure and move on.
  Verified by a 25-way concurrency test.
- The claim is decoupled from GitHub, so it is fast and testable offline (the
  concurrency test needs only a throwaway local repo).
- Going multi-machine later means swapping the ref backend for option 2
  (`gh api` create-ref) behind the same `claim()` interface — no other code changes.
- The lock is released explicitly on merge; an abandoned claim leaves a ref that a
  future `orch doctor`/reaper can detect (a heartbeat/stale-claim sweep is a natural
  extension).
