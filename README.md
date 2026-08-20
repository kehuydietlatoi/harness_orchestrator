# harness_orchestrator (`orch`)

Run **Claude Code** and **Codex** as parallel coding agents on the same repo — safely.

Worktree-isolated parallel agents are common in 2026 (Claude Squad, Parallel Code, Vibe Kanban, swarm-protocol, …). `orch` is built around the two things those tools *don't* do:

1. **Mandatory cross-*model* review before merge** — a PR written by Claude can only merge after Codex approves it, and vice versa. Self-approval is structurally impossible.
2. **Shared project memory across harnesses** — one canonical `AGENTS.md`; `CLAUDE.md` is a `@AGENTS.md` redirect, so both agents read (and write) the same brain.

On top of that it provides the commodity plumbing done cleanly: an **atomic task-claim** (a `git` ref used as a distributed mutex), **one git worktree per task**, a GitHub-Issues board, and an **`orch run` dispatcher** that launches each harness headless per ticket.

## Status

Early development. Phase P0 (scaffold: `orch init`, `orch doctor`, CI) is in place; board/claim, adapters, and the merge gate are landing next. See the build phases in the plan.

## Requirements

- Node.js ≥ 20, git ≥ 2.15 (worktrees)
- [GitHub CLI](https://cli.github.com/) (`gh`), authenticated — the task board and PR integration run through it
- `claude` and `codex` CLIs on PATH (for the agent adapters)

## Quickstart (dev)

```bash
npm install
npm run orch -- doctor      # environment check
npm run orch -- init        # scaffold config + memory redirect + GitHub labels
```

## Architecture

See [`docs/`](docs/) (ADRs) and the layered `src/` (`git.ts` / `github.ts` wrappers, `lock.ts` claim, `adapters/` harness seam, `runner.ts` dispatcher, `review.ts` merge gate).

## Prior art

- [awesome-agent-orchestrators](https://github.com/andyrewlee/awesome-agent-orchestrators)
- [swarm-protocol](https://github.com/phuryn/swarm-protocol) — closest coordination-layer prior art

## License

MIT
