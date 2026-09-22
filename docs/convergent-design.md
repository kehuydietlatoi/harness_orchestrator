# Convergent design: `orch` and Claude Projects

A short note on how `orch` relates to Anthropic's
[*Projects, redesigned*](https://claude.com/blog/projects-redesigned) announcement
(Sep 17, 2026): the same core workflow, reached independently, with a few
deliberate design choices the product does not make.

## In plain terms

- **harness** — the program that runs a coding AI. Here, **Claude Code** and **Codex**.
- **worktree** — a separate, isolated copy of the code, so two agents never edit the
  same files at once.
- **orchestrator** — the coordinator that hands out work, keeps it separate, and gets
  it reviewed.

## The same pattern, two implementations

In the announcement, Claude "scopes the request, delegates the work, coordinates
parallel threads, reviews the outputs, and assembles the finished result." Each
thread is an independent Claude Code **cloud** session on its own repo branch, with
shared memory across threads.

`orch` implements that same shape: a **board + claim-lock + lifecycle** state machine
coordinates peer agents, each task runs in an isolated **git worktree** on its own
branch (claimed off shared GitHub Issues), and one canonical **`AGENTS.md`** memory is
read by every harness.

**The shared core idea:**

- **Delegate & parallelize** — many work streams run at once, each on its own isolated branch.
- **Review before assembly** — outputs are checked, not merged blindly, before they land.
- **Shared memory** — project decisions and context persist across every thread / agent.
- **Monitor high-level or drill in** — a top-level view, plus per-thread / per-task detail.

## Where the two differ

| Dimension | Claude Projects | `orch` |
|---|---|---|
| **Coordinator** | One orchestrating Claude fans out to its own sub-threads (hierarchical, single brain) | No orchestrating LLM — a deterministic board, claim-locks & lifecycle (decentralized, engineered) |
| **Agents** | Homogeneous Claude Code sessions (single vendor) | Claude Code *and* Codex as peers (cross-vendor) |
| **Review** | Claude reviews its own outputs | One harness cross-reviews the other's PRs + human merge gate ([ADR-0003](adr/0003-cross-review-is-a-process-guarantee.md)) |
| **Runtime** | Managed cloud sessions (local "coming soon") | Local-first CLI over one repo + its worktrees (runs today, offline) |
| **Isolation** | Branch per cloud thread | Atomic git-ref claim + one worktree per task ([ADR-0002](adr/0002-atomic-claim-via-git-ref.md)) |
| **Recovery** | Managed by the platform | Observed-state reconciliation; preserves work it can't prove safe to drop ([ADR-0006](adr/0006-recoverable-task-lifecycle.md)) |

## The deliberate choices that make `orch` its own thing

1. **Coordination as a state machine, not a prompt.** The "orchestration" is
   claim-lock + lifecycle + review-queue logic — auditable and testable, with no
   central agent to trust or pay per token.
2. **Cross-vendor peer review.** Codex reviews Claude's work and vice-versa. A second,
   different harness on the diff is a stronger gate than a model grading itself.
3. **Local-first, today.** Runs against a real repo and its worktrees on your machine —
   no cloud dependency, which the managed product is still working toward.
4. **Recoverable by design.** Interrupted runs reconcile from durable git/GitHub facts
   and converge to a safe state, rather than trusting an agent's memory of what it was doing.

## Timeline

| Date | Event |
|---|---|
| **Aug 20, 2026** | `orch` — first commit. The board, claim-locks, worktrees and cross-review land over the following weeks. |
| **Sep 8, 2026** | `orch` — core architecture in place (49 commits), CI green on Linux & Windows. |
| **Sep 17, 2026** | Anthropic announces *Projects, redesigned* — the same delegate → parallelize → review → assemble workflow. |

The design was committed to git **weeks before** the announcement. This is convergent
design, not a response to it — the difference in coordinator model (a decentralized
board vs. a single-brain orchestrator), cross-vendor peer review, local-first execution,
and recoverable lifecycle are considered engineering positions, not gaps.

---

*Reference: Anthropic, "Projects, redesigned," Sep 17, 2026 — <https://claude.com/blog/projects-redesigned>*
