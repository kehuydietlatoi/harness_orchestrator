# ADR-0006: Recoverable task lifecycle is derived from facts

- Status: Accepted
- Date: 2026-08-25

## Context

A task is represented in several independently updated places: a GitHub issue and PR,
a claim-lock ref, a worktree and branch, and run telemetry. Commands cannot update all
of them atomically. A crash can therefore leave a truthful lock beside a stale status
label, or a failed-run record after its worktree has already been pruned. Treating a
single label as authoritative hides those partial failures and can make a recoverable
task look active forever.

We considered retaining labels as the state machine, deriving state ad hoc in each
board/doctor/recovery caller, and placing one pure domain model between observation and
all consumers. Labels are convenient to display but are not transactional; duplicated
derivation would give each consumer a subtly different answer.

## Decision

`src/tasks/lifecycle.ts` is the single pure lifecycle model. Its input is a `TaskFacts`
snapshot containing only observed issue, lock, worktree, branch, PR, and latest relevant
telemetry facts. Status and review labels are deliberately not input. The model returns
one `TaskState`, including invariant violations and a recovery direction when the state
requires intervention. It performs no I/O.

The stable states and their evidence are:

| State | Coherent evidence |
|---|---|
| `ready` | Open issue; no claim resources, PR, unresolved run outcome, or unsubmitted commits |
| `claimed` | Open issue and lock; worktree setup may be incomplete, but no commits or PR exist yet |
| `in-progress` | Open issue, lock, worktree, and an ahead branch; no PR yet |
| `in-review` | Open issue and open PR, with lock, worktree, ahead branch, and no failed current run |
| `needs-attention` | Coherent but non-happy evidence: failed/no-commit run, closed-unmerged PR, or ahead branch with no claim |
| `done` | Closed issue with no active lock or worktree; a PR may be merged, closed, or absent for a manual resolution |
| `inconsistent` | Facts violate one or more lifecycle invariants or match no coherent state |

State precedence is deliberate: contradictions become `inconsistent` before any normal
state is considered; a closed, cleaned issue is terminal; recoverable failure evidence
beats active-state inference; an open PR beats branch progress; and a lock beats a
worktree/branch heuristic. This makes partial failure visible instead of accepting the
most optimistic fact.

The invariants enforced by the model are:

- Lifecycle facts map to an observable GitHub issue; a missing or inaccessible issue is
  not guessed to be open or closed.
- A worktree has a branch and is protected by a claim lock.
- A closed issue retains neither a claim lock nor a worktree.
- An open PR maps to an open issue and retains the lock, worktree, and ahead branch.
- A merged PR maps to a closed issue.
- Submitted telemetry has a PR.
- Failed/no-commit telemetry cannot describe an open PR and must have released claim
  resources.

Transitions are decisions, not mutations. `decideTaskTransition` accepts or rejects an
event before an adapter writes anything. `reset` means the recovery is complete: the
adapter has released claim resources, resolved an open PR, deliberately preserved or
discarded ahead branch work, and superseded the unresolved telemetry outcome.

```text
ready --claim--> claimed --start-work--> in-progress --submit--> in-review --merge--> done
in-progress --run-failed--> needs-attention --reset--> ready
in-review --request-changes--> in-progress
claimed / in-progress / in-review --reset--> ready
```

`done` is terminal. `inconsistent` has no automatic transition: a recovery operator must
inspect its violation list, repair the observations, and derive again. This is safer than
guessing whether to delete work or recreate missing ownership.

Lifecycle labels are a disposable projection produced by `projectLifecycleLabels`:
normal states map to their `status:*` label and both attention states map to
`needs-attention`. A missing, duplicated, or stale label can be reconciled from the
derived state; it can never overrule observed facts. `review:needed` depends on the
separate cross-review decision, not merely on being `in-review`; agent, effort,
provenance, and review-history labels likewise remain separate routing/audit metadata.

## Recovery

- `run-failed` / `no-commits`: inspect telemetry and logs, then reset (release lock,
  prune worktree, and supersede the unresolved run observation) before retrying.
- `pr-closed`: inspect why the PR closed, then either restore the review path or reset
  the task for another attempt.
- `orphaned-work`: inspect the ahead branch, then restore a protected worktree or
  deliberately abandon the work. Never discard it merely because the lock is absent.
- `inconsistent`: follow every returned invariant violation. Preserve potentially useful
  branch/PR work while restoring ownership, or clean terminal residue after confirming
  completion; then collect fresh facts and derive again.

## Consequences

- Tests can exhaust the finite facts matrix and transition table without GitHub, git,
  filesystem, process, clock, or telemetry I/O.
- Future board, doctor, and recovery commands should collect observations once and use
  this model rather than interpreting status labels independently.
- Recovery completion must supersede the latest unresolved telemetry outcome; otherwise
  a reset task will correctly continue to derive as `needs-attention`.
- Observation and mutation remain adapters outside the lifecycle seam. This change
  defines the model only; wiring every existing command to it can proceed incrementally.
