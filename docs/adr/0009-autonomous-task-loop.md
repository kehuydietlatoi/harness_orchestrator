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
rather than pushed from, since its commits would land on the PR. The harness runs with write access,
so the same proof is repeated immediately before anything is published, and before the cold-session
fallback launches a second writable run after a failed resumed one: a branch switch, a detached HEAD, or
rewritten history during a run is refused, and nothing further runs or is pushed.

CI is read *strictly* by the loop (`prChecksState(..., { strict: true })`): `gh` also prints nothing
usable when it could not ask at all (network, auth, rate limit), and the dashboard's lenient reading of
that as "fail" would make a healthy PR look red and trigger a writable fix. A failed lookup puts the PR
in `unobserved`, which decides no step and keeps the loop polling.

**3. It must converge or hand off.**
Each task has a round budget (`maxReviewRounds`, default 3) of *spent* rounds: the larger of the
number of distinct earlier heads that drew a change request (each was answered by a fix, since the head
moved on) and the fixes recorded in the local event log. A request pending on the current head has not
been answered, and several requests on one unchanged head (a second reviewer, a repeated review) still
ask for a single fix, so neither is spent: a budget of N allows N fixes, and the N+1th request escalates. Exhausting it, or failing the
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
re-pause a harness for an unrelated failure, suppress the cold-session fallback, and bypass escalation.
Telemetry follows the same rule: `recordRun` reads usage from the run's own byte range, a failed resume
that falls back to a fresh session is recorded as its own run, and the Codex adapter reads its thread id
from what it appended, so a retry that reports nothing never inherits an earlier attempt's tokens or id.
If two open PRs map to one issue, which is "the" task PR is a human decision: the loop drives neither,
reports the issue as ambiguous once, and does not let it block the loop. That is decided from the
complete open-PR list *before* any per-PR lookup (`Observation.ambiguous`), so a twin that fails to load
still counts and its readable, approved sibling can never look unique and be merged.

Failure counts, retry timers and the "paused" marker belong to a *step*, not to an issue. A failed
review followed by a manual approval and one failed merge is a first failure of the merge, not a second
failure of the issue, and a review that a paused harness refused must not hold back a merge that became
ready meanwhile (a merge needs no agent). Only the refused step itself is a "retry after a pause", and
the idle deadline is enforced *before* such a retry is relaunched: with `--poll` at least as long as the
pause, every poll would otherwise make the retry actionable again and the loop would never give up.

Escalation is the safety valve, so it is retried, but not blindly: when escalating itself fails (the
label or comment write errors), the attempt backs off, is bounded (`MAX_ESCALATION_FAILURES`, then the
issue is reported as `escalationFailed` and left alone), and is not counted as progress, so `--max-idle`
still applies. A fix that has been pushed is a spent round even if the label update that follows fails:
that projection is disposable (`orch repair` restores it), so the executor keeps the `fix.pushed` signal
and notes the warning rather than failing, and a completed harness run is always recorded in telemetry. Failures back off; a paused harness
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
