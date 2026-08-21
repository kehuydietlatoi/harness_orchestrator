# Architecture

`orch` coordinates two coding harnesses (Claude Code + Codex) working in parallel
on one repository. It keeps **no durable state of its own** — everything lives in
three shared sources of truth, so the two harnesses cannot diverge:

| Source of truth | Holds | Accessed via |
|---|---|---|
| **GitHub** (Issues + PRs) | the task board, assignments, review state | `gh` CLI |
| **`AGENTS.md`** (in the repo) | shared project memory | file + git; `CLAUDE.md` is a `@AGENTS.md` redirect |
| **git worktrees + refs** | isolated per-task work, the claim mutex | `git` |

## Module map

```
cli.ts                 command router (commander)
config.ts              orch.config.json (BOM-tolerant)
util/exec.ts           buffered subprocess helper (no shell)
util/spawn.ts          streaming subprocess + log capture + timeout
git.ts / github.ts     thin `git` / `gh` wrappers (issues, PRs, labels, checks, refs)
lock.ts                atomic claim: git-ref mutex (create-only)
worktree.ts            per-task worktree lifecycle
board.ts               eligibility + dependency parsing + rendering
labels.ts              status / agent / reviewed-by label vocabulary
service.ts             claim (specific/next), submit
brief.ts               buildBrief — task briefing handed to each harness (used by runner.ts)
review.ts              review routing + the merge gate (evaluateGate is pure)
runner.ts              the `orch run` dispatcher loop
memory.ts              shared-memory append/list
plan.ts                tickets -> issues, round-robin assignment
adapters/              HarnessAdapter seam + claude/codex implementations
commands/              one file per CLI command
```

## The three load-bearing mechanisms

### 1. Atomic claim (`lock.ts`)

Two agents must never work the same ticket. Claiming creates a ref
`refs/orch/lock/issue-<n>` with `git update-ref --stdin`'s `create` verb, which
**atomically fails if the ref already exists**. Same-machine agents share one
repo, so a local ref is a sound mutex (and is shared across worktrees). Exactly
one racer wins; losers move on. See ADR-0002.

### 2. Cross-harness merge gate (`review.ts`)

The headline property: a PR may merge only if a **different** harness approved it.
Because both agents authenticate as the same GitHub user (and GitHub forbids
self-approval), approval is tracked at the *agent* level via `reviewed-by:<agent>`
labels, not GitHub's native review author. `evaluateGate()` is a pure function —
given a single params object `{ author, reviewers, agents, requireCrossReview,
checksPass, checksDetail, requireHumanMerge, humanApproved }` (where
`requireCrossReview` toggles the cross-review gate and `checksDetail` explains a
red CI) it returns the blocking reasons — and is unit-tested in isolation.

### 3. Harness adapters + dispatcher (`adapters/`, `runner.ts`)

`HarnessAdapter` abstracts "run a harness headless in a worktree" behind
`runTask` / `runReview` / `healthCheck`. Adding a harness = one file. The prompt
is delivered on **stdin** and the worktree is the process **cwd**, so nothing
untrusted touches argv. `orch run` claims → worktrees → spawns the adapter →
verifies the agent submitted (or auto-submits its commits), keeping up to
`maxConcurrent` tasks in flight, each atomically claimed.

## The task lifecycle

```
plan ──> issue(status:todo) ──assign──> agent hint
                 │
   run/next ─ claim (ref mutex) ─> worktree + status:claimed
                 │
            harness works (headless, in worktree)
                 │
              submit ─> push + PR("Closes #n") + status:in-review + review:needed
                 │
   other harness ─ review-approve ─> reviewed-by:<other>
                 │
              merge ─(gate: cross-review + green CI)─> squash-merge
                 │
        issue closed · lock released · worktree pruned · dependents unblock
```
