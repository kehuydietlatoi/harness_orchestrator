# Project memory (canonical — read by ALL harnesses)

> **Write convention:** record durable project facts HERE, not in native harness memory.
> **Work loop:** `orch next --agent <you>` → work in the printed worktree → `orch submit`.
> **Review:** when `orch review-queue --agent <you>` is non-empty, review the other harness's PRs.

## Conventions
_(add project-specific facts, gotchas, and architectural decisions below)_

- **Batched issue lookups**: `eligibleIssues` (`src/board.ts`) and `reviewQueue` (`src/review.ts`) resolve dependency/PR issue state from a single `listIssues({state:"open"})` result indexed by `byNumber(...)` — never a per-dep/per-PR `getIssue`. An issue absent from that open-issue map (closed, missing, inaccessible) is treated as non-blocking / skipped, matching the old `openDeps` semantics. Keep new hot-path issue lookups on the batched map; reserve `getIssue` for single-target paths (`checkMergeGate`, `resolvePrIssue`).
- **Claim-lock lifecycle** (`refs/orch/lock/issue-<n>`): a lock is released on exactly these paths — successful merge (`src/review.ts`), claim-setup rollback (`src/service.ts`), a failed/no-commit run (`processNext` in `src/runner.ts`), and `orch abandon <n>` (`src/commands/abandon.ts`). Any new terminal state for a task must release the lock and prune its worktree, or the issue becomes un-reclaimable.
- **Run telemetry**: every completed `processNext` harness run appends exactly one best-effort record to `~/.orch/<project>/runs.jsonl`. Missing/malformed logs and telemetry IO errors must yield null usage or a warning without changing the task outcome.
