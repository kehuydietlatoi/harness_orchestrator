# ADR-0010: The lead is consulted at decision points, behind one human gate

- Status: Accepted
- Date: 2026-10-07

## Context

ADR-0009 made claim → implement → review → fix → merge autonomous. The steps around it were
still manual: after an interactive `orch plan` session the operator had to create the issues
(`orch plan tickets.json`), route them (`orch assign --auto`), and start `orch autopilot`, which
then also picked up any unrelated routed backlog and ended on an idle timeout rather than when
the work was done. Planning and routing ran on the lead's `hard` tier (Sonnet at medium effort by
default), and the brainstorm's reasoning was lost when the session exited: only `tickets.json`
survived, so implementers, reviewers, and any later decision saw *what* to build but not *why*.

The obvious way to close the gap is to keep the planning model alive as a "main agent" that
supervises the run: it launches the loop, watches events, and decides what to do when a task
gets stuck. We considered that and rejected it as the core design:

- **Crash safety.** The loop survives a crash because it re-derives every decision from GitHub
  and Git (ADR-0006, ADR-0009). A supervising session's memory is not durable: a closed terminal,
  a sleeping laptop, or a harness update ends the supervision.
- **Cost and budget.** A run lasts hours. A long-lived session re-reads its whole, growing context
  on every turn at the strongest model's price, competes with the workers for the same usage
  budget, and compacts away exactly the brainstorm detail that justified keeping it alive.
- **Safety boundary.** A supervisor needs broad permissions (launch an auto-merging loop, edit
  labels, merge). Acting through raw tools would bypass the guards the loop's races required
  (stale observations, duplicate fixes, Ctrl-C mid-read), and it widens the prompt-injection
  surface over untrusted PR and review text (ADR-0007).
- **Portability and testability.** The behaviour would live in a prompt tied to one harness.

## Decision

**orch drives; the lead is consulted.** The deterministic loop remains the only thing that acts.
The lead harness runs headless, with fresh context, at the few points that need judgment:
interactive and draft planning, routing (the judge), and handling a task that is stuck. Each
call is bounded, fail-closed, and parsed against a contract, like the judge.

**The lead runs on its own model.** Each adapter may set `leadModel` (`resolveLeadModel`: the
lead adapter's `leadModel`, else its `hard` tier). A Claude lead defaults to Opus at high effort;
task runs keep the cheaper tiers. The calls are rare, so the stronger model costs little.

**The reasons travel with the work.** The interactive session also writes a short plan brief
(goal, key decisions, constraints, rejected alternatives, acceptance). orch embeds it in every
created issue as a collapsed "Plan context" block. Because the issue body is the spec every
harness receives, implementers, reviewers, fix sessions, and later lead calls all keep the
brainstorm's reasoning with no new store. The brief is neutralized so its prose never becomes a
dependency, it is capped rather than truncated, and it stays out of the plan identity so editing
it never duplicates issues. The planner may also route each ticket (`agent`, `effort`) while it
has the most context; the judge routes only what the plan left open.

**One human gate.** After the session, orch previews the plan and asks once whether to create
the issues, route them, and start the autopilot. `--yes` approves up front; without a terminal
orch only prints the next commands. On approval the pipeline creates the issues, routes the gaps,
and starts an autopilot **scoped to the plan's issues**: it claims and drives nothing else, and
stops with *plan complete* when every scoped issue is closed or handed to a human. Each stage
stops the pipeline on failure and prints the command that resumes it, so nothing runs on a
half-created or unrouted plan.

## Consequences

- The operator's work is: brainstorm, approve once, and handle escalations.
- Routing from an approved plan carries no `assigned-by:brain` label: the operator approved it
  with the plan. Routing the judge adds still does.
- A scoped run never routes or claims unrelated backlog. An issue it cannot finish (blocked on
  work outside the plan, or left unrouted) is reported as still open rather than waited on forever.
- A supervising session could still be added later as an optional layer that talks to the
  operator and acts only through `orch` commands; nothing in the loop would depend on it.
