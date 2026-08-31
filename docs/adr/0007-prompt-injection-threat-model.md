# ADR-0007: Prompt injection is a trusted-authorship risk, not a sanitization boundary

- Status: Accepted
- Date: 2026-08-31

## Context

`orch` drives coding agents (Claude Code, Codex) over content it does not author:
issue titles and bodies (the task brief), `Depends-on:` references, PR diffs and
review comments consumed during cross-review, and the routing/plan briefs
assembled from all of these. That content is passed to the agent as prompt
input.

Every subprocess runs through `src/util/exec.ts` with `shell: false` and an argv
vector, so task content cannot inject a *shell* command or break out of argv
quoting (and `commandExists` no longer interpolates into `sh -c`). Shell/command
injection is therefore a closed class. Prompt injection is a different one: the
content is natural-language instruction to a model, and a model can be steered by
instructions embedded in the data it is asked to act on. A crafted issue or PR
could try to make an agent exfiltrate secrets from the workspace, edit files
outside the task's intended scope, weaken or fabricate a review, or open
unrelated PRs.

Sanitizing free-form issue/PR text against this is not tractable. There is no
reliable syntactic marker separating "the task" from "an injected instruction,"
and escaping or stripping natural language would break the legitimate use — the
issue body *is* the instruction we want the agent to follow.

## Decision

Treat all issue/PR/review content as **untrusted input to the agent**, and place
the security boundary at **who may author issues and PRs in the repository**, not
at any content-sanitization step `orch` performs. `orch` does not, and will not,
attempt to sanitize task content against prompt injection.

The trust model:

- Anyone who can open an issue or PR in the repo is inside the trust boundary and
  can attempt to steer an agent. For a private repo with a small team, that is
  the same set of people who could already push code — so injection buys an
  insider little they could not already do directly.
- The controls that do exist are mechanism- and process-level, not
  content-level:
  - `shell: false` + argv everywhere removes shell/command injection (a distinct,
    already-closed class).
  - **Cross-review before merge (ADR-0003)** is the primary backstop: a second,
    differently-tasked agent reviews the diff before it can merge, raising the
    cost of an injection that must also survive review. Per ADR-0003 this is a
    *process* guarantee, not a forgery-proof one.
  - The dashboard write-surface is loopback + CSRF guarded (ADR-0004); no
    untrusted network origin can trigger a dispatch.
  - Human merge remains the final gate.

## Consequences

- A malicious author inside the trust boundary can attempt injection; the
  mitigation is review plus human merge, not prevention. This is documented,
  accepted risk for the current private-repo, human-authored-issue use.
- Because prevention is out of scope, the highest-leverage hardening is
  *containment*. Recorded here as future work, not committed by this ADR:
  - run agents with least privilege — keep ambient secrets out of the
    workspace/env the agent can read; scope credentials to the task.
  - constrain the agent's write scope to the task's declared file-ownership hints
    where the adapter supports it.
  - treat any agent action reaching outside the worktree (network calls,
    credential reads, edits to unrelated paths) as a review red flag.
- **If the repo ever accepts issues/PRs from outside the team, this ADR must be
  revisited before that boundary opens** — untrusted external authorship changes
  the risk materially.
- No code change accompanies this ADR; it records the threat model and the
  boundary so future sandboxing/credential-scoping work has a shared reference.
