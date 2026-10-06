# ADR-0009: A signal-driven, fact-derived task loop

- Status: Accepted
- Date: 2026-10-06

## Context

Until now `orch` dispatched one cold harness session per task and stopped at "PR opened". Review,
feedback, the author's rework, conflict resolution, and merge were all manual hand-offs: a reviewer's
`request-changes` only relabelled the issue, nothing re-ran the author, and the author's next session
started from nothing. That made orch a dispatcher, not an autonomous system, and wasted the author's
context on every round.

## Decision

`orch autopilot` runs each task from claim to merge. Three rules shape it.

**1. Decisions come from facts, signals only wake the loop.**
`decideStep` (`src/tasks/steps.ts`) is a pure function from observed PR facts to one next step:

| Facts (highest precedence first) | Step |
|---|---|
| issue is `needs-attention` | none - a human owns it |
| no open PR | none (claiming is the implement path) |
| latest decision on the head requests changes | `fix` (resume the author) |
| CI red | `fix` (CI) |
| PR conflicts with the base | `resolve-conflict` |
| head has no acceptable approval | `review` |
| CI pending / mergeability unknown | `wait` |
| approved, green, clean | `merge`, or `await-human` under `requireHumanMerge` |
| any fix-type step with the round budget spent | `escalate` |

When a step finishes, its result (`review.approved`, `fix.pushed`, `step.failed`, ...) wakes the loop
immediately, so a review starts the moment a PR opens and a fix starts the moment a review lands -
no polling latency. But the signal is only a wake-up and a log line: the next pass re-observes
GitHub/Git and re-derives the step. A crash, a lost or duplicated signal, a human editing labels, or
a push from outside therefore cannot strand a task. Polling remains only for events that never signal
us (CI finishing, a person acting, a harness's usage limit resetting).

**2. The author's context survives the round trip.**
The author's conversation id is stored per task (`~/.orch/<project>/sessions/`). A fix resumes it
(Claude `--resume`, Codex `exec resume`), so the author still remembers what it built and why. Resume
is an optimisation, never a dependency: if the harness refuses it, the fix is retried in a fresh
session briefed from durable facts (the spec, the diff, the review notes). Fixes and conflict merges
are pushed by orch, never forced; a new head voids earlier approvals, so the change is re-reviewed.
Before a writable harness touches the task worktree, orch proves it is the right one: Git must
register the path on the task branch (`observeWorktree`), that branch must be the PR's, and the PR
head must already be in its history. A switched, detached, or unregistered directory is refused
rather than pushed from, since its commits would land on the PR.

**3. It must converge or hand off.**
Each task has a round budget (`maxReviewRounds`, default 3) of *spent* rounds: the larger of the
change requests on the PR's own history that have since been answered, and the fixes recorded in the
local event log. A request that is still pending on the current head has not been answered, so it is
not spent: a budget of N allows N fixes, and the N+1th request escalates. Exhausting it, or failing the
same step twice in a row, escalates: `needs-attention` plus a comment explaining why. A PR that cannot
be read on a pass is reported as unobserved and the loop keeps polling; it is never mistaken for
"nothing left to do". Time spent waiting on a paused harness does not count as progress, so
`--max-idle` still ends a wait that outlasts it. Routed todos owned by a paused harness are likewise
waited for (bounded by `--max-idle`) rather than reported as a drained queue.

Two races are closed explicitly. An implementing agent runs `orch submit` itself, so its PR can exist
before its process has finished: the loop records the issue as *implementing* from the moment it is
claimed (`processNext`'s `onClaimed`) and takes no step on it until implementation has finalised. And
harness logs are append-only and shared by every retry of a round, so a run is judged only by the text
it appended itself (`logSize`/`readLogSince`); otherwise an earlier attempt's usage-limit event would
re-pause a harness for an unrelated failure, suppress the cold-session fallback, and bypass escalation. Failures back off; a paused harness
(usage limit, ADR-0008) is waited out and never counted as a failure. Merge still goes through the
full gate (`checkMergeGate`: approval bound to the head, CI, SHA-guarded squash), and conflicts are
resolved by merging the base into the branch (Claude preferred), never by rewriting history.

Slots are filled finish-before-start: merge, then escalate, fix, resolve, review, and only then new
implementation, bounded by `--max` concurrent agent runs.

## Consequences

- A task needs no human between "issue labelled" and "merged" unless it is escalated or
  `requireHumanMerge` is on. Escalation is the safety valve, so a stuck loop costs at most
  `maxReviewRounds` agent runs per task.
- Every step is appended to `~/.orch/<project>/events.jsonl` and fix/conflict runs carry a
  `phase`/`round` in `runs.jsonl`, so rounds-to-approval, escalation rate, and cost per merged task
  are measurable (the basis for the evaluation work).
- The loop trusts reviewer verdicts and CI as inputs; it does not establish review quality. Prompt
  injection and identity are unchanged from ADR-0003/0007: authorship plus cross-review plus the
  human-merge option remain the boundary. Reviewer sessions are read-only, but fix and conflict
  sessions can edit and run commands in the task worktree, like any implement run.
- Auto-merge makes a bad approval consequential faster. Teams that want a human in the loop set
  `requireHumanMerge: true`; the loop then stops at an approved, green PR.
- Not covered: automatically re-queueing a task whose *implement* run died on a usage limit (it lands
  in `needs-attention`), and a dashboard view of loop state.

## Amendment: what the loop may start

The first live run claimed two issues that nobody had routed (#68, #69): `issueStatus` treats an issue with
no `status:` label as a todo, and `orch run` has always taken unrouted work. That is fine for a dispatcher a
person starts per task, but not for a loop that also reviews and merges, so autopilot now only claims issues
that carry an explicit `agent:` label (`claimableBy(..., { requireRouted: true })`); an unrouted issue is
backlog that was never triaged, not a decision to run it. `--no-claim` restricts the loop to pull requests that
already exist, and `--dry-run` prints what would be claimed and what would be skipped. `orch run` and
`orch dispatch` are unchanged.
