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

`src/` is grouped by subsystem. Dependencies flow **downward** only —
`server`/`commands` → `routing`/`tasks` → `board` → `github`/`git` → `util` — so
each folder is a clean layer with no cross-folder cycles.

```
cli.ts                 command router (commander)               [entry]
config.ts              orch.config.json (BOM-tolerant)          [shared kernel]
memory.ts              shared memory (AGENTS.md) append/list     [shared kernel]

util/    exec.ts (buffered subprocess, no shell) · spawn.ts (streaming + log capture + timeout)
git/     git.ts (git wrapper) · worktree.ts (per-task lifecycle) · lock.ts (git-ref claim mutex, create-only)
github/  github.ts (gh: issues, PRs, labels, checks, refs) · labels.ts (status/agent/reviewed-by vocabulary)
board/   board.ts (eligibility + dependency parsing) · snapshot.ts (canonical read model) ·
         telemetry.ts (runs.jsonl) · review.ts (review routing + the merge gate, evaluateGate is pure)
routing/ assign.ts (routing brief + applyPlan) · judge.ts (LLM routing judge) · judge-eval.ts (plan validity)
tasks/   service.ts (claim/submit) · runner.ts (the `orch run` dispatcher) · brief.ts (task briefing) ·
         plan.ts (tickets -> issues, round-robin assignment)
server/  server.ts (localhost dashboard + write surface) · demo.ts (in-memory --demo fixture)
adapters/ HarnessAdapter seam + claude/codex implementations
commands/ one file per CLI command
```

## The three load-bearing mechanisms

### 1. Atomic claim (`git/lock.ts`)

Two agents must never work the same ticket. Claiming creates a ref
`refs/orch/lock/issue-<n>` with `git update-ref --stdin`'s `create` verb, which
**atomically fails if the ref already exists**. Same-machine agents share one
repo, so a local ref is a sound mutex (and is shared across worktrees). Exactly
one racer wins; losers move on. See ADR-0002.

### 2. Cross-harness merge gate (`board/review.ts`)

The gate enforces a **process guarantee**: a PR may merge only when its issue has
an author label and a `reviewed-by:<agent>` label naming different configured
harnesses. Each dispatcher passes only its own agent identity, so ordinary use
reliably prevents accidental same-label self-review. Because both harnesses share
one GitHub identity and `--agent` is a caller-supplied flag, the gate does not
authenticate which harness applied the reviewer label; a caller can impersonate
the other configured agent. See ADR-0003 for the trust boundary and a path to
cryptographic or credential-backed agent identity.

`evaluateGate()` is a pure function — given a single params object `{ author,
reviewers, agents, requireCrossReview, checksPass, checksDetail,
requireHumanMerge, humanApproved }` (where `requireCrossReview` toggles the
cross-review gate and `checksDetail` explains a red CI) it returns the blocking
reasons — and is unit-tested in isolation.

### 3. Harness adapters + dispatcher (`adapters/`, `tasks/runner.ts`)

`HarnessAdapter` abstracts harness execution behind `runTask` / `runReview` /
`healthCheck`, plus optional `runHeadless` (planner/judge) and
`runInteractivePlan` capabilities. Each adapter owns its CLI arguments and
structured-output reduction; the shared headless module owns only log capture,
timeouts, and capability dispatch. Prompts are delivered on **stdin** and the
worktree is the process **cwd**, so nothing untrusted touches argv. `orch run`
claims → worktrees → spawns the adapter → verifies the agent submitted (or
auto-submits its commits), keeping up to `maxConcurrent` tasks in flight, each
atomically claimed.

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
