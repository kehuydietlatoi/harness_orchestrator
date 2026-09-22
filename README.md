# harness_orchestrator (`orch`)

Coordinate **Claude Code** and **Codex** from GitHub issue to reviewed pull request,
with task routing, isolated worktrees, shared project memory, and recoverable runs.

## What problem does this solve?

Running several coding agents creates coordination work: deciding who owns each
task, waiting for prerequisites, keeping edits separate, carrying project knowledge
between tools, reviewing results, and recovering interrupted work. `orch` puts
those steps into a shared workflow backed by GitHub Issues, Git, and local run logs.

| Coordination problem | What `orch` provides |
|---|---|
| Turning a goal into executable work | Interactive or headless planning, ticket validation, dependency links, and retry-safe issue creation |
| Choosing an agent and effort level | A lead-agent routing judge informed by task context and run telemetry; editable suggestions or automatic assignment |
| Duplicate claims and overlapping checkouts | Atomic local Git-ref claims and one worktree per task |
| Starting work before prerequisites are ready | Dependency-aware dispatch and cycle reporting |
| Project knowledge split between tools | A canonical `AGENTS.md` with a `CLAUDE.md` redirect |
| Getting a second harness to review changes | Cross-harness review routing and a configurable merge gate, enabled by default |
| Understanding and recovering interrupted runs | A shared CLI/dashboard board, run telemetry, and safe lifecycle reconciliation |

It fits a developer or trusted team using Claude Code and Codex against **one
local repository and its worktrees**, with GitHub as the issue and PR system.
Claims coordinate processes sharing that repository's Git refs; they do not lock
tasks across independent clones or machines. Worktrees separate checkouts, but
do not prevent logical conflicts between changes.

## See it in action

`orch serve --demo` boots the dashboard against a seeded in-memory board — no
GitHub, Git, or agent CLIs needed at runtime. Drive **Suggest → edit → Apply →
Dispatch** and watch a simulated task advance into review.
Walkthrough and screenshots: [demo.md](demo.md).

```bash
npm install                    # from this project's checkout; also builds via prepare
node dist/cli.js serve --demo   # open http://127.0.0.1:4000
```

[![Suggest routing, edit assignments, and apply them in the dashboard](docs/demo/routing.gif)](demo.md)

## Requirements

- Node.js ≥ 20 and Git with worktree support
- [GitHub CLI](https://cli.github.com/) (`gh`), authenticated
- `claude` and `codex` on PATH and authenticated for the default two-agent setup
- A local repository with a GitHub `origin` and an available base branch

The demo only needs Node.js and the installed project dependencies at runtime.

## Quickstart

```bash
npm install                    # run from this project's checkout; also builds
npm link                       # puts orch on PATH (or use node dist/cli.js here)

cd ../my-project               # the GitHub repository you want agents to work on
orch init                      # config, shared memory, planning skill, GitHub labels
orch doctor                    # verify environment and project setup
```

`init` preserves existing files. If the target repository already has a
`CLAUDE.md`, ensure it points to the shared `AGENTS.md`. Commit the project setup
before starting tasks so new worktrees inherit it.

## The loop

```bash
orch plan                                         # interactive planning (currently Claude)
# Or generate a headless draft:
orch plan --draft "add SSO login" > tickets.json
orch plan --dry-run tickets.json                   # validate and preview; no writes
orch plan tickets.json                             # create issues with dependency links

orch assign --judge > assignments.json             # propose routing with the configured lead
# inspect/edit assignments.json, then:
orch assign --apply assignments.json --dry-run      # preview label changes
orch assign --apply assignments.json                # apply routing
# Or: orch assign --auto                            # judge + apply in one step

# Run in two separate terminals (Bash or PowerShell):
# terminal 1: orch run --agent claude
# terminal 2: orch run --agent codex
# Each task: claim -> worktree -> headless harness -> submit PR -> await cross-review

orch review-queue --agent codex                     # PRs awaiting Codex
orch review <pr> --agent codex                      # print diff + review checklist
# Have Codex review the changes and tests before recording its decision:
orch review-approve <pr> --agent codex               # for a Claude-authored PR
orch merge <pr>                                     # merge if the configured gate passes
```

`orch run` processes eligible work and exits after the queue is drained and active
runs finish. Restart it when new work becomes eligible, such as after merging a
dependency. `--max` limits concurrency **per dispatcher**, not across both terminals.
Use `orch dispatch <issue>` to run one routed task or `orch run --agent codex --once`
to process at most one eligible task.

Review and merge are separate steps: `orch review` prints a diff and checklist;
`review-approve` records a decision. The dispatcher does not automatically drain
the review queue. Set `requireHumanMerge: true` to require `orch merge <pr> --human`
or `orch integrate --human` for explicit sign-off.

Watch work with `orch board`, `orch status`, or `orch snapshot --json`.
For the browser dashboard, run `orch serve` and open `http://127.0.0.1:4000`
(or choose a port with `--port <n>`). It refreshes every two seconds and supports
ticket-file preview and issue creation, Suggest → edit → Apply routing, and
dispatch after confirmation. It shows dependencies, cycles, review CI status,
and recent run information.

## Recover interrupted work

```bash
orch repair                  # inspect lifecycle inconsistencies; no writes
orch repair <issue> --apply  # reconcile observed state with safe, repeatable actions
orch abandon <issue>         # release a claim when its worktree can be safely removed
```

Recovery preserves work it cannot prove safe to remove. The `--discard` option on
`orch abandon <issue>` explicitly destroys retained work in the task worktree.
See the [recoverable lifecycle design](docs/adr/0006-recoverable-task-lifecycle.md).

## Review and trust boundaries

With `requireCrossReview: true`, the merge gate requires a `reviewed-by:<agent>`
label naming a configured harness different from the issue's author label.
Harness identities and `--human` are process signals, not authenticated identities;
the gate applies to merges through `orch`, not direct GitHub merges.

Reported CI checks must pass or be skipped; **no configured checks also passes**.
The gate does not establish review quality or prove that distinct underlying
models performed the work. Issue and PR content can contain prompt injections;
the project relies on trusted authorship and cross-review, as described in its
[threat model](docs/adr/0007-prompt-injection-threat-model.md).

The dashboard binds to `127.0.0.1` and authorizes writes using local, same-origin
request checks. Off-machine access would require additional authentication.

## Command reference

| Command | Purpose |
|---|---|
| `orch init` / `orch doctor` | scaffold project setup / verify environment, labels, and dependencies |
| `orch plan [file] [--draft "<goal>"] [--dry-run] [--example]` | interactive planning without args; headless draft; file preview or issue creation; example ticket format |
| `orch assign` | emit a whole-graph routing brief with telemetry |
| `orch assign --judge` | propose routing as JSON |
| `orch assign --auto [--dry-run]` | judge and apply routing, or preview changes |
| `orch assign --apply <file\|-> [--dry-run]` | apply a routing file (or stdin), or preview changes |
| `orch assign --round-robin` | legacy assignment for eligible issues |
| `orch next` / `orch claim <issue>` | claim the next eligible task / a specific task and open its worktree |
| `orch brief <issue>` | print the task briefing |
| `orch submit <issue>` | push branch, open PR, and route cross-review |
| `orch run [--agent x] [--max n] [--once]` | process eligible tasks in isolated worktrees |
| `orch dispatch <issue>` | run one routed todo by issue number |
| `orch review-queue` / `orch review <pr>` | list review work / print a diff and checklist |
| `orch review-approve <pr>` | record a cross-review approval |
| `orch review-changes <pr> --notes "..."` | request changes from the author |
| `orch merge <pr> [--human]` / `orch integrate [--human]` | gated merge of one PR / all passing PRs |
| `orch repair [issue] [--apply]` | preview lifecycle reconciliation / execute safe repairs |
| `orch abandon <issue> [--discard]` | release a claim safely; optionally destroy retained work explicitly |
| `orch board` / `orch status` | board view / agent work and next tasks |
| `orch snapshot [--json]` | canonical open-task board as a table or JSON |
| `orch serve [--port <n>] [--demo]` | localhost dashboard; optional in-memory demo |
| `orch memory add <text>` / `orch memory list` | append / list shared project facts |

Agent identity comes from `--agent`, `$ORCH_AGENT`, or `config.lead`.
Use `orch <command> --help` for all options. Global `--verbose` / `--quiet` control
diagnostics on stderr; `ORCH_LOG_LEVEL` sets the default logging level.

## Configuration — `orch.config.json`

```json
{
  "agents": ["claude", "codex"],
  "lead": "claude",
  "requireCrossReview": true,
  "requireHumanMerge": false,
  "worktreeRoot": "../wt",
  "maxConcurrent": 2,
  "taskTimeoutMs": 1800000,
  "defaultEffort": "hard",
  "adapters": {
    "claude": { "cmd": "claude", "models": { "easy": "sonnet", "hard": "opus" } },
    "codex": { "cmd": "codex", "models": { "easy": "low", "hard": "high" } }
  }
}
```

The example shows the default routing and execution settings. `baseBranch` is
optional: when omitted, orch uses GitHub's default branch. Set it explicitly
(e.g. `"baseBranch": "main"`) to override that choice. The branch must exist
locally or as `origin/<name>` before work can be claimed, compared, repaired,
or submitted.

`effort:easy` and `effort:hard` select adapter-specific values: the Claude adapter
passes a model name, while the Codex adapter sets reasoning effort. Tasks without
an effort label use `defaultEffort`. Planning and the routing judge use the lead's
`hard` tier.

Assignment only selects issues with **neither** an `agent:` nor an `effort:` label;
it preserves existing routing, including partially labeled issues. Dependencies
are `Depends-on: #n` references in issue bodies; open prerequisites block dispatch.
Cycles are reported for manual resolution.

Completed runs append best-effort telemetry to `~/.orch/<project>/runs.jsonl`.
Cost uses harness-reported data or configured per-million-token `pricing` rates;
Codex cost remains null by default because this project treats it as subscription
usage. Telemetry informs routing, but routing quality optimization is not yet
implemented; see [judge evaluation](docs/adr/0005-judge-evaluation.md).

## Design

- [Convergent design note](docs/convergent-design.md) — how `orch`'s delegate → parallelize → review → assemble workflow (first committed Aug 2026) maps to Anthropic's "Projects, redesigned" announcement (Sep 2026), and where it deliberately differs
- [Architecture](docs/ARCHITECTURE.md) — modules and core mechanisms
- [Workflow](docs/WORKFLOW.md) — labels and issue lifecycle
- [Routing judge](docs/judge.md) — prompt contract, parsing, and evaluation
- [Build vs. adopt](docs/adr/0001-build-vs-adopt.md) — original design rationale
- [Atomic claims](docs/adr/0002-atomic-claim-via-git-ref.md) — local Git-ref mutex
- [Cross-review](docs/adr/0003-cross-review-is-a-process-guarantee.md) — process guarantee and review backlog
- [Dashboard writes](docs/adr/0004-dashboard-write-surface.md) — locality trust boundary
- [Judge evaluation](docs/adr/0005-judge-evaluation.md) — contract validity and future quality evaluation
- [Recoverable lifecycle](docs/adr/0006-recoverable-task-lifecycle.md) — observed state and safe recovery
- [Prompt injection](docs/adr/0007-prompt-injection-threat-model.md) — trusted authorship and agent inputs

## Development

```bash
npm run dev -- <command>   # run directly from source (tsx)
npm run lint              # ESLint
npm run typecheck
npm test                  # fast mocked unit suite
npm run test:coverage     # unit suite with coverage regression thresholds
npm run build             # refresh dist/ for the linked orch command
npm run test:e2e           # compile + exercise the built CLI as a subprocess
```

Set `ORCH_JUDGE_LIVE=1` to opt into live judge tests against the configured lead
CLI (`ORCH_JUDGE_LIVE=1 npm test` in Bash; `$env:ORCH_JUDGE_LIVE='1'` before
`npm test` in PowerShell).

The linked `orch` command runs `dist/cli.js`: rebuild after changing `src/` and
restart any running server. Frontend-only edits to `public/index.html` need a
browser refresh.

CI runs `lint → typecheck → test:coverage → build → test:e2e` on Linux and Windows
with Node.js 20 and 22.

## License

MIT
