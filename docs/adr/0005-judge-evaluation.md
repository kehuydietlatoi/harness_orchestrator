# ADR-0005: How we evaluate the routing judge

- Status: Accepted
- Date: 2026-08-24

## Context

The routing judge (`src/routing/judge.ts`, ADR-adjacent to the assignment design) is an
LLM-as-judge: it reads a telemetry-grounded brief and returns, for every
unassigned issue, `{issue, agent, effort, rationale}`. It is the one component
whose output we cannot fully predict, so "is it any good?" needs an explicit
answer rather than a leap of faith.

Today the judge has strong **reliability engineering** — the output contract is
embedded verbatim in the prompt, the spawn boundary is an injectable
`JudgeRunner`, and `runJudge` is **fail-closed**: a non-zero exit, timeout,
unparseable reply, or empty plan all throw and write nothing (`test/judge.test.ts`
covers each). What was missing is any check on the *decision* the judge makes. A
plan can parse cleanly and still be wrong: it can silently drop an issue, route to
an agent that isn't configured, invent an effort tier, or omit the rationale the
contract demands. `applyPlan` (the writer) drops the malformed entries it sees as
non-fatal skips, but it is structurally blind to a *missing* issue — one it never
hears about — and does not care about rationale quality.

## Decision

Split evaluation into the two questions that need different tools, and build only
the one that can be answered offline now.

1. **Validity — built now, deterministic, in CI.** A pure function
   `evaluatePlan(plan, issues, cfg)` (`src/routing/judge-eval.ts`) scores a plan against
   the issues it was asked to route and returns every violation:
   `coverage-missing`, `coverage-extra`, `duplicate`, `invalid-agent`,
   `invalid-effort`, `missing-rationale`. It has no IO and no model call, so it
   runs as ordinary unit tests over golden fixtures (`test/judge-eval.test.ts`).
   The two checks `applyPlan` cannot make — `coverage-missing` and
   `missing-rationale` — are also wired into the live `orch assign --judge/--auto`
   path as stderr warnings, so an incomplete plan is visible in daily use, not
   just in tests.

2. **Live validity — opt-in, same gate, real model.** The golden-board test also
   has a `describe.skipIf(!ORCH_JUDGE_LIVE)` block that spawns the *real* judge and
   asserts its output clears the exact same `evaluatePlan` gate. It is skipped by
   default so CI stays hermetic (no network, no lead adapter CLI), and run deliberately
   (`ORCH_JUDGE_LIVE=1 npm test`) to catch prompt/model regressions.

3. **Quality — designed, not faked.** Whether a route is *good* (not merely valid)
   needs ground truth we do not synthesize: it is an **offline replay** of
   `runs.jsonl`. For issues that were later worked, compare the judge's choice
   against the recorded outcome — did the routed agent actually finish, and at
   lower cost/tokens than the counterfactual agent for that effort tier? That is a
   data-labeling problem, so it is written up here as the roadmap rather than
   stubbed with a score that has no denominator.

## Consequences

- `evaluatePlan` is the single definition of "a contract-valid plan," shared by
  the deterministic tests, the opt-in live test, and the CLI warning. There is one
  rubric, not three.
- CI gains real signal about the judge's *completeness* without ever calling a
  model; the live gate exists for when we intend to pay for a model round-trip.
- The quality bar is explicit and honest: we claim validity is measured and
  quality is designed-but-unmeasured, which is the true state. When enough
  telemetry accrues, the replay lands as a new offline evaluator beside
  `evaluatePlan` — the seam (pure function over `plan + issues + telemetry`) is
  already the right shape.
- ADR-0004's `POST /actions/suggest` returns the same `PlanEntry[]` this module
  scores, so the dashboard's suggestions are evaluable by the identical gate with
  no new surface.
