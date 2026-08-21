# harness_orchestrator (`orch`)

Run **Claude Code** and **Codex** as parallel coding agents on the same repo — safely.

Worktree-isolated parallel agents are commodity in 2026 (Claude Squad, Parallel
Code, Vibe Kanban, swarm-protocol, …). `orch` is built around the two things those
tools *don't* do:

1. **Mandatory cross-*model* review before merge** — a PR written by Claude can only
   merge after Codex approves it, and vice versa. Self-approval is structurally
   impossible.
2. **Shared project memory across harnesses** — one canonical `AGENTS.md`; `CLAUDE.md`
   is a `@AGENTS.md` redirect, so both agents read (and write) the same brain.

On top of that it provides the commodity plumbing done cleanly: an **atomic
task-claim** (a `git` ref used as a distributed mutex), **one git worktree per
task**, a GitHub-Issues board, and an **`orch run` dispatcher** that launches each
harness headless per ticket.

## Requirements

- Node.js ≥ 20, git ≥ 2.15 (worktrees)
- [GitHub CLI](https://cli.github.com/) (`gh`), authenticated — the board + PRs run through it
- `claude` and `codex` on PATH (for the agent adapters)

## Quickstart

```bash
npm install && npm run build
npm link                       # puts `orch` on your PATH (or use `node dist/cli.js`)

cd ../my-project               # a GitHub repo
orch init                      # config + AGENTS.md/CLAUDE.md redirect + labels
orch doctor                    # verify git, gh auth, worktrees, adapters, labels
```

## The loop

```bash
orch plan tickets.json                 # lead: JSON tickets -> issues (deps + file hints)
orch assign                            # round-robin pre-assign to agents (optional)

# run the two dispatchers concurrently — one per terminal:
#   terminal 1:  orch run --agent claude
#   terminal 2:  orch run --agent codex
# on Windows PowerShell, launch both from one shell with Start-Process:
#   Start-Process orch 'run --agent claude'; Start-Process orch 'run --agent codex'
# (POSIX `orch run --agent claude & orch run --agent codex &` backgrounds on bash,
#  but `&` does NOT background in PowerShell/cmd — the two would run sequentially)

# each daemon, per task:
#   claim (atomic) -> worktree -> spawn harness headless -> submit (PR + route review)
#
# then, cross-review:
orch review-queue --agent codex        # PRs awaiting codex
orch review-approve <pr> --agent codex # satisfies the gate for a claude-authored PR
orch merge <pr>                        # only if: green CI + approved by the OTHER harness
```

You watch `orch board` / `orch status`, and either trust the gate or set
`requireHumanMerge` to sign off yourself.

## Command reference

| Command | Purpose |
|---|---|
| `orch init` / `orch doctor` | scaffold config + memory + labels / verify environment |
| `orch plan <file>` | create issues from a JSON tickets file (deps + file-ownership) |
| `orch assign` | round-robin pre-assign eligible issues to agents |
| `orch next` / `orch claim <n>` | atomically claim a task, open its worktree |
| `orch brief <n>` | print the task briefing (spec + memory pointer + loop) |
| `orch submit <n>` | push branch, open PR (`Closes #n`), route cross-review |
| `orch run [--agent x] [--max n] [--once]` | dispatcher: claim + drive the harness |
| `orch review-queue` / `review <pr>` | list / inspect PRs awaiting your review |
| `orch review-approve <pr>` / `review-changes <pr>` | record cross-review outcome |
| `orch merge <pr>` / `orch integrate` | gated merge (one / all mergeable) |
| `orch board` / `orch status` | board view / your work + what's next |
| `orch memory add <text>` / `memory list` | shared memory (AGENTS.md log) |

Agent identity comes from `--agent`, `$ORCH_AGENT`, or `config.lead`.

## Configuration — `orch.config.json`

```json
{ "agents": ["claude","codex"], "lead": "claude",
  "requireCrossReview": true, "requireHumanMerge": false,
  "worktreeRoot": "../wt", "maxConcurrent": 2, "taskTimeoutMs": 1800000,
  "adapters": { "claude": {"cmd":"claude"}, "codex": {"cmd":"codex"} } }
```

## Design

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — modules, the three load-bearing mechanisms, task lifecycle
- [docs/adr/0001-build-vs-adopt.md](docs/adr/0001-build-vs-adopt.md) — prior-art survey + why build
- [docs/adr/0002-atomic-claim-via-git-ref.md](docs/adr/0002-atomic-claim-via-git-ref.md) — the claim mutex

## Development

```bash
npm run dev -- <command>   # run from source (tsx)
npm run typecheck
npm test                   # atomic-claim concurrency, spawn plumbing, merge-gate policy
```

## License

MIT
