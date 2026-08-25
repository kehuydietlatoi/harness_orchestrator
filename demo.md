# Demo — the `orch` dashboard & routing judge

A two-minute tour of the live control plane: watch two coding agents work a shared
board, then let the **routing judge** decide who builds what — and apply it with one click.

![Suggest → Apply — the routing loop end to end: the judge proposes an agent and effort tier for every unassigned issue, then one click writes the labels and the board updates live](docs/demo/routing.gif)

_The whole loop above runs against the seeded `--demo` board — no GitHub, git, or agent CLIs. The four sections below break it down frame by frame._

## Run it yourself (no setup)

The demo is fully self-contained — **no GitHub, no git repo, no `claude`/`codex` on
PATH.** It swaps only the I/O boundary (GitHub/git/judge) for an in-memory board;
every HTTP route, the loopback guard, and the real `applyPlan` / `selectUnassigned`
routing logic run unchanged.

```bash
npm install && npm run build
node dist/cli.js serve --demo      # then open http://127.0.0.1:4000
```

---

## 1. The live board

Open tasks projected from GitHub Issues + PRs + git worktrees + run telemetry, refreshed
every 2 s. Each row shows status, owning agent, its PR, cross-review state, whether the
task is **locked** (the atomic git-ref claim) and has a **worktree**, and the token/cost
of its latest run.

![The live board](docs/demo/01-board.jpg)

Here two agents are mid-flight: `claude` and `codex` each hold an in-progress task (locked,
worktree open) and each have a PR in review. Three issues (#107–#109) are still unrouted.

## 2. Suggest routing — the judge

Clicking **Suggest routing** runs the headless judge in-process. It reads a routing brief
(each unassigned issue's scope + dependencies + per-agent telemetry) and returns, for every
issue, **which agent** should build it and at **what effort tier** — each with a
one-sentence rationale grounded in the telemetry it used.

![Judge suggestions with rationales](docs/demo/02-suggest.jpg)

- **#107 Dashboard routing UI → `claude` / hard** — design-heavy, cross-cutting UI work.
- **#108 Cross-review backlog view → `codex` / easy** — a localized read projection; routed
  to the cheaper median-cost agent at the cheaper model tier.
- **#109 Telemetry-grounded judge scoring → `codex` / hard** — threads through modules codex
  already owns.

Effort is an **abstract, agent-neutral tier** (`easy` | `hard`); each adapter maps it to its
own model concept at spawn time (claude → `sonnet`/`opus`, codex → reasoning-effort
`low`/`high`). Every row is editable — the judge proposes, a human disposes.

## 3. Apply — write the plan back

**Apply** sends the (possibly hand-edited) plan to `POST /actions/assign`, which runs the
real `applyPlan` validator and writes `agent:` / `effort:` labels. Judge-authored rows are
additionally stamped `assigned-by:brain` for provenance; hand-edited rows are not. The board
updates live.

![After applying the routing plan](docs/demo/03-applied.jpg)

All three todos now carry an owner (`@claude` / `@codex`) and drop out of the unrouted set —
a second **Suggest** would return nothing to route.

Note they stay **`todo`**: routing only assigns an *owner*, never status. In real use a dispatcher
(`orch run`) then claims each one — flipping it `claimed` → `in-progress` → `in-review` — and spawns
the harness. `--demo` runs no agents, so the lifecycle deliberately stops at routing; the seeded
tasks **#103–#106** show those later states statically.

## 4. Cross-review queue

The merge gate is a **process guarantee**: a PR may merge only when its issue carries an
author label and a `reviewed-by:<agent>` label naming a *different* configured harness. The
review queue surfaces exactly the PRs awaiting that cross-model sign-off.

![The cross-review queue](docs/demo/04-review-queue.jpg)

---

## What's real vs. faked in `--demo`

| Real (runs unchanged) | Faked (in-memory fixture) |
|---|---|
| Every HTTP route + the `isLoopback` write guard | GitHub Issues/PRs (`gh`) |
| `applyPlan` / `selectUnassigned` routing validation | git worktrees + the claim lock |
| The board snapshot → dashboard render path | the judge's LLM call (canned plan) |
| `Suggest → edit → Apply` round-trip, incl. `assigned-by:brain` | run telemetry (`runs.jsonl`) |

The fixture lives in [`src/server/demo.ts`](src/server/demo.ts) and is wired through the same `ServerDeps`
seam the tests use, so the demo exercises the production code paths rather than a mock-up.

## More

- [README](README.md) — the full loop and command reference
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the three load-bearing mechanisms
- [docs/adr/](docs/adr/) — build-vs-adopt, the atomic claim, the cross-review trust boundary,
  and the dashboard write surface
