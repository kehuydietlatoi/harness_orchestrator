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

## Exclusive path claims (#173)

Claims with ticket-v2 `locks` create the issue ref and every
`refs/orch/lock/path/<sha256(normalized-path)>` ref in one `update-ref --stdin`
transaction. Path refs point to blobs containing the issue number, normalized
path/glob, and issue owner token. Release compare-deletes the issue and its
matching path refs in one transaction; it needs no current issue-body lookup.
Setup rollback, merge, abandon, safe runner recovery, and repair therefore share
the same ownership boundary. Retained worker output keeps its path claims.

Hash equality alone cannot exclude overlapping globs. Before reading the path
namespace, acquisition reads a persistent version ref,
`refs/orch/path-lock-version`. The claim transaction also compare-updates that
version to a fresh random blob. A concurrent addition invalidates the snapshot;
the loser re-reads and retries. This ref is a version, never a held mutex, so a
coordinator crash cannot strand a global lock. Releases only remove conflicts
and need no version update. Conflicts return ordinary unavailability and leave
no issue projection or worktree behind.

`src/git/path-locks.ts` compares glob languages without expanding the checkout,
protecting files that do not exist yet. Paths are repository-relative, with
portable `/` separators and normalized `./` segments; absolute paths and `..`
segments are rejected. A path also protects its descendants. Matching is case
sensitive and supports `*`, `**`, `?`, character classes/ranges (including
negation), and brace alternatives. Extglobs and brace expansions above 256
variants conservatively overlap all paths. Use simple globs for precise claims.

Plan validation rejects overlaps between tickets without a transitive hard
dependency; advisory `after` ordering grants no exclusivity. Asset tickets
require nonempty locks. Repair discovers path-ref owners independently of issue
refs and reports path refs with no matching live claim, preserving them for
inspection.
