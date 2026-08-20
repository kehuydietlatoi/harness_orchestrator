# ADR-0001: Build our own vs. adopt an existing orchestrator

- Status: Accepted
- Date: 2026-08-20

## Context

Running multiple coding agents in parallel over git worktrees is a crowded
category in 2026. A survey of prior art:

| Tool | Runs Claude+Codex | Worktrees | GitHub Issues board | Cross-*model* review gate | Shared memory |
|---|---|---|---|---|---|
| Parallel Code | yes (+Gemini) | yes | no | no | no |
| Vibe Kanban | yes | yes | own board | no | no |
| Claude Squad | yes (+more) | yes | no | no | no |
| swarm-protocol | any MCP client | conflict-aware | own state | no | task ctx only |
| Conductor / Crystal | desktop | yes | no | no | no |
| Claude Code Agent Teams | Claude-only | yes | no | yes, same model | shared task list |

Worktree isolation + a board + launching agents is **commodity**. Two
capabilities are **not** available off the shelf:

1. Mandatory review by the *other model/harness* before merge.
2. Shared project memory treated as a versioned source of truth across harnesses.

## Decision

Build our own, leading with the two differentiators; keep the commodity plumbing
lean. (This is also a portfolio project, so end-to-end ownership and architecture
quality are explicit goals.)

## Consequences

- We own the claim primitive, the dispatcher, and the merge gate — and can make
  the gate enforce cross-*harness* review, which nothing else does.
- We reimplement worktree/board plumbing that some tools already provide; we keep
  it thin and delegate to `git` and `gh` rather than reinventing them.
- The closest prior art (swarm-protocol's MCP coordination) remains a viable
  future backend for the claim/coordination layer if we ever go multi-machine.

## References

- awesome-agent-orchestrators — https://github.com/andyrewlee/awesome-agent-orchestrators
- swarm-protocol — https://github.com/phuryn/swarm-protocol
