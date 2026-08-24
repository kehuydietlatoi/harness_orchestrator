# Project memory (canonical — read by ALL harnesses)

> **Write convention:** record durable project facts HERE, not in native harness memory.
> **Work loop:** `orch next --agent <you>` → work in the printed worktree → `orch submit`.
> **Review:** when `orch review-queue --agent <you>` is non-empty, review the other harness's PRs.

## Conventions
_(add project-specific facts, gotchas, and architectural decisions below)_

- **Batched issue lookups**: `eligibleIssues` (`src/board.ts`) and `reviewQueue` (`src/review.ts`) resolve dependency/PR issue state from a single `listIssues({state:"open"})` result indexed by `byNumber(...)` — never a per-dep/per-PR `getIssue`. An issue absent from that open-issue map (closed, missing, inaccessible) is treated as non-blocking / skipped, matching the old `openDeps` semantics. Keep new hot-path issue lookups on the batched map; reserve `getIssue` for single-target paths (`checkMergeGate`, `resolvePrIssue`).
- **Claim-lock lifecycle** (`refs/orch/lock/issue-<n>`): a lock is released on exactly these paths — successful merge (`src/review.ts`), claim-setup rollback (`src/service.ts`), a failed/no-commit run (`processNext` in `src/runner.ts`), and `orch abandon <n>` (`src/commands/abandon.ts`). Any new terminal state for a task must release the lock and prune its worktree, or the issue becomes un-reclaimable.
- **Run telemetry**: every completed `processNext` harness run appends exactly one best-effort record to `~/.orch/<project>/runs.jsonl`. Missing/malformed logs and telemetry IO errors must yield null usage or a warning without changing the task outcome.
- **Board projection**: `buildSnapshot` (`src/snapshot.ts`) is the canonical read model for open tasks. Keep GitHub/Git/telemetry reads in that module and add derived board fields to its pure `assemble(...)` helper so terminal, JSON, and dashboard consumers share one mapping. `Snapshot.reviewQueue` contains PR numbers carrying `review:needed`.
- **Dashboard boundary**: `src/server.ts` serves only `GET /` and `GET /status`; `/status` calls `buildSnapshot` in-process, and `startServer` binds only `127.0.0.1`. Keep Phase 1 read-only. Future mutations belong under an authenticated `/actions/*` surface without changing these read routes.
- **Effort routing boundary**: task effort is the abstract tier `easy | hard`, mapped through each adapter's `models` config before invocation. `RunContext.model` carries the resolved agent-specific value and affects `runTask` only; review invocations do not receive model flags.
- **Assignment routing boundary**: plain `orch assign` emits a whole-open-graph routing brief for issues missing both `agent:` and `effort:` labels; `--apply` is fill-blanks-only and never replaces either existing routing label. Keep lead judgment external and assignment planning pure in `src/assign.ts`; `--round-robin` is the legacy eligibility-gated path.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues (via the `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
