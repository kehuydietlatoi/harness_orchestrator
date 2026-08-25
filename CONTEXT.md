# CONTEXT — project glossary

The canonical vocabulary for `harness_orchestrator`. One term, one meaning. When a
word here is overloaded or wrong, fix it here first, then in the code — this file is
the source of truth for what the words mean. Hard-to-reverse decisions live in
`docs/adr/`; the label/state machine these terms describe lives in `docs/WORKFLOW.md`.

## Actors

- **orch** — the CLI orchestrator. Drives the whole board via the `gh`/`git` CLIs.
- **agent / harness** — one of the two coding harnesses that do the work: `claude`
  (Claude Code) or `codex` (Codex). They share **one GitHub identity**; orch tracks
  "who did what" at the *agent* level via `agent:` / `reviewed-by:` labels, not via
  distinct GitHub users. See ADR-0003.
- **lead** — the configured agent (`cfg.lead`, default `claude`) that acts as the
  human's proxy for cross-cutting judgment: routing decisions, reviews initiated by a
  person. The lead is *also* an implementer harness; "lead" is a role, not a 3rd agent.

## The board

- **board** — the set of GitHub Issues + PRs for the repo. There is **no database**;
  GitHub is the state, git is the code, `runs.jsonl` is the telemetry. Everything else
  is a *derived projection* over those three.
- **issue** — one unit of work. Its **status** (`status:*` label), **owner**
  (`agent:*`), and **effort** (`effort:*`) are all carried as labels.
- **dependency** — a `Depends-on: #n` line in an issue body. An issue is **blocked**
  while any dependency is still open. Blocking is *computed on read*
  (`isEligible` / `openDepsFromMap`), never stored — see the `status:blocked` note in
  `docs/WORKFLOW.md`.
- **eligible** — an issue that may be claimed now: `status:todo`, unlocked, and not
  blocked. `eligibleIssues` returns these in ascending number order.

## Routing (the assignment brain)

Routing gives each issue two decisions, each recorded as a label:

- **effort** — an **abstract, agent-neutral tier**: `easy` | `hard`. It is
  **model selection, not a thinking ladder**: each agent maps the tier to *its own*
  model concept via `cfg.adapters.<agent>.models` (claude → `--model sonnet|opus`;
  codex → `-c model_reasoning_effort=low|high`). Resolved to a concrete model at spawn
  by `resolveTaskModel` (`issueEffort ?? cfg.defaultEffort ?? "hard"`).
- **owner** — which agent runs it: `agent:claude` | `agent:codex`. Honored by
  `claimNext` (an issue pinned to the other agent is skipped).

The pieces of the routing pipeline:

- **brief** — the deterministic text a judge reads: every unrouted open issue (body,
  deps, files-hint) plus a per-agent **telemetry rollup** (`formatBrief`, `src/routing/assign.ts`).
- **judge** — the reasoning step that turns a brief into a plan. **External and
  swappable**: the interactive lead in-session today, a headless `claude -p` later
  (`src/routing/judge.ts`, planned). Both emit the *same* plan shape. The judge only *proposes*.
- **plan** — the machine-readable routing decision:
  `[{ issue, agent, effort, rationale }]`. The contract between judge and writer.
- **writer** — the deterministic step that applies a plan to labels
  (`applyPlan` + `editIssue`, `src/commands/assign.ts`). **Fill-blanks-only**: it never
  overrides an issue that already carries an `agent:` or `effort:` label. Same writer
  regardless of who the judge was.
- **suggestion** — one row of a plan as shown in the dashboard: the judge's
  `{agent, effort, rationale}` for an issue, pre-filled and editable before it is written.
- **override** — a human changing a suggestion's agent/effort (or filling a blank row)
  in the dashboard before applying. An override is a *human pin*.
- **assigned-by:brain** (planned) — provenance label added by the writer only when the
  applied decision came from the judge, not a human. Lets a future re-routing pass
  revise *its own* past picks while never touching a human pin.

## Surfaces

- **snapshot** — the canonical read model of the open board (`buildSnapshot` /
  `assemble`, `src/board/snapshot.ts`). Terminal, JSON, and dashboard all render from it.
- **dashboard** — the localhost web UI (`src/server/server.ts`, `127.0.0.1` only). **Read-only
  today** (`GET /` + `GET /status`). The routing UI (planned) adds an authenticated-by-
  locality **mutation surface** (`POST /actions/*`) behind a single `assertLocal`
  chokepoint — the first writes the dashboard is allowed to make.

## The work loop

- **claim** — atomically take an eligible issue: acquire a git-ref lock
  (`refs/orch/lock/issue-<n>`), label it `status:claimed` + `agent:<me>`, cut a
  **worktree**. Rolls the lock back on setup failure (ADR-0002).
- **worktree** — an isolated git checkout under `worktreeRoot` (`../wt/issue-<n>`)
  where one task runs without disturbing others.
- **run** — drive the harness over the claimed issue in its worktree (`processNext`).
  Ends in exactly one **outcome**: `submitted`, `needs-attention`, or `failed`.
- **submit** — push the branch, open a PR that closes the issue, move it to
  `status:in-review` + `review:needed`, routed to the *other* harness.
- **cross-review** — the merge invariant: a PR needs a `reviewed-by:<other-agent>`
  approval before it may merge. An agent may **never** review its own work. This is a
  *process* guarantee, not a GitHub-identity one (ADR-0003).
- **gate** — the pure merge decision (`evaluateGate`): cross-review present + CI green
  (+ optional human confirm). Empty reason list = may merge.
- **telemetry** — one `RunRecord` appended to `~/.orch/<project>/runs.jsonl` per
  completed run (tokens, cost, duration, outcome). Best-effort; never changes an
  outcome. Grounds the judge's routing.

## Dogfood convention

New batches are built by **codex as sole implementer**; **claude cross-reviews and
merges**. Tickets are dependency-chained, each independently test-green. This is orch
running on its own repo.
