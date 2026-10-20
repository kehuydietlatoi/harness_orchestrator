# ADR-0015: The observe gate

Accepted, 2026-10-20 (#220). Records observe configuration (#215), evidence
execution (#216), judging (#217), and autopilot integration (#218).

## Context

Passing tests and source review do not establish that a running interface shows
what a ticket requires. Tickets can declare `observe: [scenario, ...]` to require
runtime evidence for their `Observe:` acceptance lines. orch remains a
domain-neutral coordinator: the project or pack owns scenario definitions and
the evidence runner, including any browser or game automation.

The gate must inspect the exact PR head, preserve the host execution boundary in
[ADR-0013](0013-ticket-verify-trust.md), and require an independent visual judge.
It must also distinguish a visible acceptance failure from a broken verifier and
from ordinary CI failures.

## Decision

### Decision-table placement

In `src/tasks/steps.ts`, the normal PR decision order is unresolved review
feedback, failing CI, conflict resolution, observe, review, external settling,
then merge. Existing attention, scope, push-settling, budget, and recovery guards
still apply. Only tickets with a nonempty `observe` list require this gate;
tickets without it retain their existing behavior.

Observe runs after conflict resolution because resolving a conflict changes the
head being inspected. It runs before review because a red screenshot never
costs a reviewer: visibly unmet acceptance returns to the author before spending
a source-review run. Observe and subsequent review do not wait for pending CI,
so they overlap CI; known failing CI still selects its fix first. Merge waits
for all required gates on the current head.

A `not-verified` verdict selects an observe fix using the normal fix-round and
lead-triage budgets. Missing or failed evidence, an inconclusive or blocked
verifier, or a failed judge escalates to `needs-attention` rather than pretending
to be a code acceptance failure.

### Trusted execution and checkout ownership

`evidence` is a nonempty argv array and `evidenceSetup` is a list of argv arrays
loaded from coordinator configuration only. Like project `verify`, they are
operator-authorized commands under ADR-0013; issue text cannot supply or replace
them. Unlike the constrained ticket `verify` extension, there is no ticket
evidence-command extension. Ticket scenario names select data, not executables.

`src/tasks/evidence.ts` prepares a detached checkout of the full PR head SHA,
runs setup commands there, then invokes the configured evidence argv for each
scenario with `<scenariosDir>/<name>.json` and `<outDir>` appended as separate
arguments. The default scenarios directory is `qa/scenarios`. Commands use
`exec` with `shell: false`, a per-command `evidenceTimeoutMs` (five minutes by
default), the scrubbed `verifyEnvironment`, and `PWD` fixed to the checkout.
The runner must write `run.json` with that SHA and `ok: true`; missing files,
wrong SHA, or command failure do not establish successful evidence.

Configured commands can execute PR-written code. Environment cleaning reduces
inherited credential exposure; it is not OS isolation and does not prevent
access to profile login files. ADR-0013's trust and review boundary still applies.

The caller owns the evidence checkout through judging and releases it on every
exit path. Release uses the shared link-safe `prepareWorktreeRemoval` guard:
scan without entering symlinks or Windows junctions, unlink links
non-recursively before Git removal, and retain the checkout if safe cleanup or
Git removal fails. Dependency installation does not justify bypassing this guard.

### Independent visual judge

`src/tasks/observe-judge.ts` selects a judge at tier `standard` with explicit or
default `vision` capability and a provider family different from the
implementation author's resolved family. It uses the cross-review selection
and availability rules of `pickReviewer`, including endpoint cooldowns. The
rule is always cross-family, regardless of `reviewPolicy`: there is never a
same-family or self-judge fallback. When no candidate qualifies, the task goes
to `needs-attention` with `no vision-capable judge of another family`.

The judge runs read-only, using the pack's `gates/observe.md` or the built-in
procedure. Regular evidence files are staged under `.orch-observe/` in the
detached checkout without following links. The judge reads state, screenshots,
and logs and returns a fenced JSON verdict bound to the head SHA, with one
verdict per `Observe:` acceptance line. Overall `verified` requires every
expected line to be verified and
successful evidence for the scenarios. Taste and feel remain human playtest
concerns. [ADR-0012](0012-multi-provider-routing.md) records capability defaults
and the Codex PNG-reading probe supporting its default vision capability.

### SHA-bound record, separate from CI

The published record is the commit status `studio/observe` on the inspected SHA
(`success` for verified, `failure` otherwise) plus a PR comment containing the
verdict table, evidence paths, and structured `orch-observe:v1` metadata. The
executor rechecks the PR head before publishing, so a superseded run cannot
certify the new head.

Observation reads the current-head status and newest valid comment matching the
PR number and SHA. Merge requires both `success` and the matching `verified`
record. Missing, malformed, unreadable, stale, or inconsistent records grant no
approval; a new head needs new evidence and judgement.

After a human handback (#233), a blocked current-head record becomes missing
when the issue's latest `needs-attention` removal is strictly newer than the
record comment's GitHub creation time. The loop retries observe on the same SHA;
a fresh blocked record is newer than that handback and escalates again. Only
blocked facts read the paginated issue events. An unreadable event list leaves
the PR unobserved for that pass.

The CI roll-up excludes `studio/observe` from `ChecksFact`. Otherwise a failed
visual verdict would appear as red CI and dispatch `fix ci`, losing the observe
feedback and blocked-verifier distinction. Excluding this context does not
waive the separate observe merge gate or any ordinary CI requirement.

### Local evidence retention

Evidence stays under `<evidenceDir>/<issue>/<sha>/<scenario>/`, outside the
canonical checkout. By default `evidenceDir` is the project state directory's
`evidence` folder (normally `~/.orch/<project>/evidence`). Each scenario folder
is replaced on a rerun of the same issue/SHA/scenario; different heads retain
separate evidence. The project runner owns the contents, typically `run.json`,
`shots/`, `state/`, and `console.log`.

Evidence is never committed or uploaded as screenshots to the PR. The PR comment
records local paths for inspection; releasing the temporary checkout does not
delete the retained evidence. This gate uses semantic judgement of state and
images, with no pixel baselines or pixel-diff approval policy.

## Consequences

Observe tickets spend evidence and judge time before source review, reducing
review effort on visibly incomplete work while keeping pending CI concurrent.
Each pushed head invalidates earlier visual approval. Projects must provide
useful scenarios, a working trusted runner, and an available independent vision
judge; broken capture infrastructure requires attention rather than an automatic
acceptance fix.

Local retention avoids repository image churn and external screenshot storage,
but paths in PR comments are only useful on the machine holding the evidence;
operators own its storage and retention. No pixel baseline needs maintenance,
and visual judgement remains dependent on evidence coverage and judge quality.
The gate supplements tests, source review, and human playtesting without proving
subjective quality or isolating untrusted code from the host.
