# ADR-0012: Multi-provider routing

Accepted, 2026-10-19.

Phase 1 separates task intent, harness, model family, and billing so implementations
can use inexpensive endpoints and advance when a provider is unavailable. This ADR
records the implemented routing and recovery boundaries, plus the owner's default
selection and provider-terms decisions. Approval policy remains in
[ADR-0011](0011-premium-family-review-and-conflict-resolvers.md); the detailed
OpenCode runtime contract is in [the adapter guide](../opencode-adapter.md).

## Tiers and roles

[src/config.ts](../../src/config.ts) defines the ordered tiers
`free | cheap | standard | lead`. They express task effort independently of the
harness's model and reasoning flags. Legacy `easy` means `standard` and `hard`
means `lead`, with configurable `tierAliases`; canonical names take precedence
over legacy model-config keys. A model spec carries `model`, `effort`, and `family`.

[src/routing/route-policy.ts](../../src/routing/route-policy.ts) owns
`validateRoute`: `roles[role]` declares allowed tiers and families, and both must
match. An issue without a `role:` label is unrestricted; an unknown role fails
closed. Assignment and execution share this check rather than inventing separate
allowances. A role constrains where work runs; it does not authorize approval.

`resolveFamily` in [src/config.ts](../../src/config.ts) prefers the selected
model's family over the adapter default (Claude defaults to `anthropic`, Codex to
`openai`). OpenCode must specify a family per configured model and never inherits
the adapter family: one OpenCode harness can run models from multiple providers,
so its executable name cannot establish provider identity. Config validation in
[src/config.ts](../../src/config.ts) requires a family for OpenCode adapter model
specs and both a model and family for resolved ladder members. At invocation,
`OpencodeAdapter.run` in [src/adapters/opencode.ts](../../src/adapters/opencode.ts)
requires an explicit provider/model.

## Default model order

The owner decision is deliberate: an explicit `model:<id>` label wins; otherwise
use the first entry in the tier's configured `tierMembers` ladder for the assigned
agent. Use the adapter's tier model only when no applicable ladder is configured.
The adapter model must not silently take priority over a ladder's first member.
`resolveTierModel` in [src/config.ts](../../src/config.ts) implements that order,
merges the selected member over the adapter tier spec, and rejects an unknown
explicit model projection. Its ladder lookup filters by assigned agent; when no
member matches that agent it returns the adapter tier spec. Ladder configuration
must therefore include the intended assigned agent to obtain ladder selection.

## Pricing modes

`resolvePricingMode` in [src/config.ts](../../src/config.ts) supports
`api | subscription | quota`, defaulting respectively to Claude API, Codex
subscription, and OpenCode quota. Operators can override the mode per adapter.
[src/board/pricing.ts](../../src/board/pricing.ts) estimates API cost using
configured per-million-token rates, including cache reads; unknown pricing stays
unknown. Subscription estimates are null; quota estimates are zero.

[src/tasks/runner.ts](../../src/tasks/runner.ts) prefers reported dollar cost to
an estimate, except that quota forces zero dollars while preserving request
counts. [src/board/quota.ts](../../src/board/quota.ts) records quota requests by
UTC day and endpoint in `quota.json`. Zero here represents quota accounting,
not a claim that every provider service is free.

## Cooldowns

[src/adapters/usage-limit.ts](../../src/adapters/usage-limit.ts) defines a
10-minute default for endpoint errors, including failed health checks. OpenCode
429 reset headers can override that endpoint default. Harness usage-limit
messages use a parsed reset time; otherwise
[src/board/availability.ts](../../src/board/availability.ts) uses 60 minutes.
It clamps stored cooldowns to between one minute and twelve hours.

The usage-limit parser interprets explicit English dates and AM/PM clocks in
local time; only a bare clock rolls to its next occurrence. Invalid dates fall
back to the default. `availabilityKey` in
[src/board/availability.ts](../../src/board/availability.ts) scopes OpenCode
cooldowns to `opencode:<provider/model>`, while Claude and Codex share cooldowns
within their respective harnesses. A single failed endpoint must not park every
OpenCode model. [src/tasks/runner.ts](../../src/tasks/runner.ts) reads the current
run's log and uses these cooldowns in recovery and fallback selection.

## Health checks

[src/board/health.ts](../../src/board/health.ts) gates OpenCode before a claim,
persists successful and failed slug probes in `health.json` for 10 minutes, and
shares concurrent probes through one promise. Failure also sets a 10-minute
endpoint cooldown. Claude and Codex bypass these probes.
`pingEndpoint` in [src/adapters/opencode.ts](../../src/adapters/opencode.ts)
sends `Reply OK` on stdin with a 60-second timeout and requires exit zero,
completed reduction, and exactly `OK` as the trimmed response.

## Cascade

`nextHop` in [src/tasks/cascade.ts](../../src/tasks/cascade.ts) walks forward
through members and then higher tiers, skips already-tried members, checks role
policy, and uses the caller's availability predicate to skip cooldowns. An absent
ladder preserves existing retry/wait behavior; it does not invent a fallback.

A model down at dispatch falls back immediately: `preClaimHealthy` in
[src/tasks/runner.ts](../../src/tasks/runner.ts) relabels the still-unclaimed todo
to the next eligible member after a failed health gate, without spending an
implementation invocation. In-run usage/endpoint failures may hop only after
proving no commits or open PR, safe worktree removal, and lock release. Retained
work instead follows failed-run recovery.

[src/tasks/cascade-requeue.ts](../../src/tasks/cascade-requeue.ts) projects the
new agent, effort, and model labels. Every successful hop emits `cascade.hop`
through [src/tasks/runner.ts](../../src/tasks/runner.ts) or, for PR fix cascades,
[src/tasks/step-exec.ts](../../src/tasks/step-exec.ts); failed relabelling emits
no hop. Implementation records also carry `cascadeFrom`/`cascadeTo` when a run
occurred. PR cascades preserve the PR, claim, and worktree and clear the saved
session. [src/tasks/coordinator.ts](../../src/tasks/coordinator.ts) consumes
`onCascade`, clears destination drain markers after the attempt settles, and
keeps the loop going on the replacement endpoint in the same run (#151).

## Orch-committed leftover changes

Workers never need Git write access to complete an implementation.
`commitWorkerOutput` in [src/tasks/runner.ts](../../src/tasks/runner.ts) handles
a completed run with no commits but a dirty worktree: confirm the claimed branch,
run configured verify commands, stage changes, commit with
`<issue title> (#<number>)` and a `Worker: <agent>; model: <model@effort>` body,
then use normal submission in [src/tasks/service.ts](../../src/tasks/service.ts).
Existing worker commits use the ordinary submit path.

Originally, verify commands came only from the coordinator-loaded `orch.config.json` `verify`
argv arrays, validated by [src/config.ts](../../src/config.ts), never from issue
text or worker-provided instructions. This is a trust boundary: orch executes
them outside any harness sandbox, in the task worktree, through
[src/util/exec.ts](../../src/util/exec.ts) with `shell: false` and a five-minute
timeout per command. Failed verification retains the worktree and claim, marks
needs-attention, and comments the failing argv/output tail instead of submitting.
[src/adapters/opencode.ts](../../src/adapters/opencode.ts) allows only safely
representable literal verify commands in writable profiles and keeps push denied.

[ADR-0013](0013-ticket-verify-trust.md) extends this boundary with constrained
ticket argv, a cleaned environment for all host checks, and lead review of
protected verification paths.

## Budgets and budget-stop reporting

[src/tasks/budget.ts](../../src/tasks/budget.ts) owns per-ticket minutes, USD,
and requests, merged per dimension as defaults < tier < issue `Budget:` line.
It aggregates the issue's runs across phases and agents. Unknown dollar cost
blocks another run only when USD is capped. Legacy records count as one request;
[src/tasks/runner.ts](../../src/tasks/runner.ts) records at least one per harness
invocation while preserving larger reducer counts.

[src/tasks/budget-runtime.ts](../../src/tasks/budget-runtime.ts) rechecks limits
before invocations, including fallback attempts after predecessor telemetry, and
shortens timeouts to remaining minutes. Ticket exhaustion bypasses lead triage
through [src/tasks/steps.ts](../../src/tasks/steps.ts). A ticket-shortened
implementation timeout is recorded as run outcome `budget-spent` by
[src/tasks/runner.ts](../../src/tasks/runner.ts), with needs-attention reason
`budget spent` and the existing recovery hold.
[src/tasks/facts.ts](../../src/tasks/facts.ts) treats it as unresolved failure;
[src/board/report.ts](../../src/board/report.ts) reports `budget-stopped`
separately, subject to later runs or terminal loop events (see #160 below).

## CI-failure escalation

[src/tasks/steps.ts](../../src/tasks/steps.ts) escalates a failed CI fix to a
human instead of cascading or asking lead triage when CI still fails and there
is no overriding review feedback (#144). The author may be unable to fix an
infrastructure or external failure; paying for another model is not evidence of
progress. [src/tasks/coordinator.ts](../../src/tasks/coordinator.ts) tracks
failures against the observed head.
[src/tasks/step-exec.ts](../../src/tasks/step-exec.ts) requires net file changes
before pushing a fix; empty commits count as failed fixes.

## Permission isolation

[src/adapters/opencode.ts](../../src/adapters/opencode.ts) writes a unique
per-run `OPENCODE_CONFIG` outside the checkout and grants `external_directory`
only to the canonical run worktree's `/*`, preceded by a deny-all rule. It
removes the config after the child exits. Repository `opencode.json`,
`opencode.jsonc`, and `.opencode` settings are ignored via
`OPENCODE_DISABLE_PROJECT_CONFIG=true`; inherited config-content, directory,
and permission overrides are cleared.

OpenCode 1.19.3 applies project permissions after `OPENCODE_CONFIG`, so a
repository allow rule otherwise defeats the run's restrictions. Evidence and
reproduction are recorded in [ADR-0007](0007-prompt-injection-threat-model.md)
(#142). OpenCode permissions are application policy, not an OS sandbox;
trusted global configuration and host access remain operator responsibilities.

## Provider terms

Owner decision: Claude workers only ever run through the official `claude` CLI.
The OpenCode adapter never uses Claude subscription credentials and may run
non-Claude models, or Claude through an API key or OpenCode Zen paid. Gateways
that put non-Claude models behind Claude Code are not used.

[src/adapters/claude.ts](../../src/adapters/claude.ts) and
[src/adapters/opencode.ts](../../src/adapters/opencode.ts) implement the separate
CLI invocation paths; [src/config.ts](../../src/config.ts) supplies executable
and model configuration. These modules do not validate credential provenance or
gateway billing. The owner must enforce this deployment policy in trusted
configuration; it is not a claim of automated terms enforcement.

## Known open gaps

- **#160:** `orch report` can show an autopilot budget stop as escalated.
  [src/tasks/coordinator.ts](../../src/tasks/coordinator.ts) and
  [src/tasks/step-exec.ts](../../src/tasks/step-exec.ts) emit escalation for this
  loop path; [src/board/report.ts](../../src/board/report.ts) lets terminal loop
  events supersede the budget-stop classification. Implementation
  `budget-spent` reporting alone does not resolve this gap.
- **#159:** a stale mergeability read immediately after the loop's own push can
  repeat `resolve-conflict`. The push is in
  [src/tasks/step-exec.ts](../../src/tasks/step-exec.ts), observations come from
  [src/tasks/observe.ts](../../src/tasks/observe.ts), and
  [src/tasks/steps.ts](../../src/tasks/steps.ts) still selects conflict resolution
  from that read. This ADR records the gap without changing retry behavior.
