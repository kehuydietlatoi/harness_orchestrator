# ADR-0014: Domain packs and ticket schema v2

Accepted, 2026-10-19 (#177). Records Phase 2: metadata (#171), packs (#172),
path claims (#173), briefs (#174), host verification (#175), and routing filters
(#176). The source is the pack's [ticket schema v2 spec](https://github.com/kehuydietlatoi/agenticGamedevSkills/blob/main/docs/specs/ticket-schema-v2.md)
and [JSON schema](https://github.com/kehuydietlatoi/agenticGamedevSkills/blob/main/pack/schemas/ticket.v2.schema.json).
This ADR describes the implemented contract, including differences from that draft.

## Pack boundary

Game knowledge belongs in the pack. orch remains a domain-neutral coordinator:
it loads role data, applies policy, renders prompts, and drives the deterministic
loop described in [ADR-0010](0010-lead-at-decision-points.md).
`src/pack/load.ts` reads manifests and prompts as data; `src/tasks/brief-render.ts`
substitutes project and ticket context into a pack-owned template. Neither runs
pack scripts or implements game-specific gates. Manifest `kinds`, `needs`,
`gates`, and `read_only` are loaded data, not independent runtime enforcement of
domain workflows; kind-specific prototype relaxation and milestone gates are
not implemented here.

`src/config.ts` enables pack validation only when `pack` is configured.
`src/tasks/plan-create.ts` and `src/tasks/ticket-metadata.ts` preserve v1 issue
rendering when v2 fields are absent; `src/tasks/runner.ts` keeps the legacy
`src/tasks/brief.ts` path when no pack is set. Explicit new routing fields or
sensitivity configuration can opt into their policies without a pack.

## Pack config and role manifests

`loadConfig` in `src/config.ts` resolves `pack` relative to the configuration
directory and exposes `loadedPack`. `src/pack/load.ts` reads sorted
`roles/<id>.json` manifests and sibling Markdown prompts. IDs must match their
filenames and be lowercase role slugs; prompt names must identify sibling `.md`
files. It validates required strings, string arrays, known kinds/tiers, and the
optional boolean `read_only`, collecting manifest failures with their paths.
JSON avoids adding a YAML parsing dependency.

`src/config.ts` derives `roles` allowances from manifest `tiers` and `families`;
an explicit config `roles.<id>` replaces that whole allowance entry.
`src/tasks/plan.ts` still requires pack membership: a config-only role cannot
satisfy the pack requirement. `src/routing/route-policy.ts` enforces the merged
tier/provider-family allowance at routing and execution boundaries. Pack load
failures surface through `src/commands/doctor.ts`.

## V2 fields and projections

`TicketV2`, `V2_FIELDS`, and structural validation in `src/tasks/plan.ts` own the
field contract. `src/tasks/ticket-metadata.ts` writes the optional fields as a
versioned JSON section headed `Ticket metadata (v2)`; `parseTicketV2` in
`src/tasks/plan.ts` reads it with the same structural checks. Metadata preserves
argv boundaries and empty optional arrays. The parser and renderer are also
re-exported by `src/tasks/plan-create.ts`.

| Field | Type and projection | Enforcing/consuming module |
| --- | --- | --- |
| `role` | Lowercase slug; `role:<id>` label and role prompt/allowance | `src/tasks/plan-create.ts`, `src/routing/route-policy.ts`, `src/tasks/brief-render.ts` |
| `kind` | `code`, `asset`, `design-data`, `qa`, `prototype`, `docs`; `kind:<kind>` label | `src/tasks/plan.ts`, `src/tasks/plan-create.ts` |
| `milestone` | Nonempty string; GitHub milestone, created if missing | `src/tasks/plan-create.ts`, `src/github/github.ts` |
| `decisions` | Unique `D-###` IDs (at least three digits); decision rows in brief | `src/tasks/plan.ts`, `src/tasks/brief-context.ts`, `src/tasks/brief-render.ts` |
| `context` | Unique dotted anchors; section excerpts in brief | `src/tasks/plan.ts`, `src/tasks/brief-context.ts`, `src/tasks/brief-render.ts` |
| `locks` | Unique repository paths/globs; exclusive claim refs | `src/tasks/plan.ts`, `src/git/path-locks.ts`, `src/git/lock.ts` |
| `verify` | Nonempty list of nonempty argv arrays of nonblank strings; brief and authorized host checks | `src/tasks/plan.ts`, `src/tasks/verify.ts`, `src/tasks/runner.ts` |
| `needs` | Unique subset of `shell`, `vision`, `web`, `engine`, `image-gen`, `audio-gen`; route filter | `src/tasks/plan.ts`, `src/routing/route-policy.ts` |
| `sensitivity` | `public`, `internal`, `secret`; label and route filter | `src/tasks/plan-create.ts`, `src/routing/route-policy.ts` |
| `budget` | Nonnegative finite `minutes`, `usd`, integer `requests`; existing `Budget:` line and effective limits | `src/tasks/plan.ts`, `src/tasks/plan-create.ts`, `src/tasks/budget.ts`, `src/tasks/budget-runtime.ts` |
| `model` | String; `model:<id>` label pins a configured tier member | `src/tasks/plan-create.ts`, `src/config.ts` |

`buildPlanMarkers` in `src/tasks/plan-create.ts` excludes all v2 fields from
plan/ticket identity. Editing these fields therefore does not duplicate issues
on a creation retry. Existing fields retain their meanings: in particular,
`files` is an ownership hint (and an additional write allowance for pack scope
enforcement below) and `after` is advisory ordering.

## Validation rules 1-7

`parseTickets` in `src/tasks/plan.ts` reports all structural errors together;
`resolvePlan` repeats structural checks and accumulates semantic errors across
tickets. Diagnostics identify the ticket position, local ID when supplied, and
field (pairwise lock errors name both tickets). Malformed JSON or a non-array
document fails before ticket validation. CLI planning (`src/commands/plan.ts`),
dashboard preview/create (`src/server/server.ts`), and the creation gate
(`src/tasks/plan-create.ts`) share this pure validator. Callers supply loaded
config and a design snapshot rather than performing I/O inside validation.

1. **Existing plan checks.** `src/tasks/plan.ts` blocks missing titles and
   duplicate IDs. Self/unknown/later dependencies are warned about and dropped,
   leaving only backward references, so the resolved plan cannot contain a
   dependency cycle. Definition-of-done concerns from
   `src/tasks/definition-of-done.ts` remain warnings, as do overlapping `files`
   hints. The draft's reference to existing checks does not make these warnings
   blocking errors; `src/board/graph.ts` separately detects runtime issue cycles.
2. **Pack requirements.** `src/tasks/plan.ts` requires `role`, `kind`, and
   `verify` when `pack` is set, checks actual pack role membership, and rejects
   explicit effort/family assignments outside the merged role allowance.
3. **Exclusive assets and parallel work.** `src/tasks/plan.ts` requires nonempty
   locks for `kind: asset` and uses `src/git/path-locks.ts` to reject overlapping
   locks unless a transitive hard `dependsOn` path orders the tickets. `after`
   does not qualify.
4. **Resolvable design references.** For pack plans,
   `src/tasks/brief-context.ts` checks decisions against `design/decisions.md`
   and rejects superseded IDs; context anchors must resolve through
   `design/INDEX.md` to a readable section inside `design/`. Callers pass
   `ResolveOptions.design`; `src/tasks/brief-render.ts` reloads and rechecks at
   dispatch so stale references cannot silently produce a brief.
5. **Sensitivity.** `src/tasks/plan.ts` tests candidate routes through
   `src/routing/route-policy.ts`, rejecting a plan with no permitted route;
   `src/tasks/runner.ts` repeats policy checks before adapter construction.
6. **Capabilities.** The same modules require at least one allowed route
   satisfying every ticket need. Explicit assignments and model pins are checked
   against the model dispatch would select, rather than a different capable
   member of the ladder.
7. **Verify argv and trust.** `src/tasks/plan.ts` validates argv structure and
   collects `verifyTrustErrors` from `src/tasks/verify.ts`; the runner repeats
   authorization before host checks. Execution uses `src/util/exec.ts` with
   `shell: false`. The trust boundary is summarized below and owned by ADR-0013.

The draft's additional rule 8 is implemented in `src/tasks/plan.ts` and
`src/routing/route-policy.ts`: `engine`, `image-gen`, and `audio-gen` fail with a
Phases 3-4 tooling diagnostic. Declaring capabilities cannot enable those future
tools in Phase 2.

## Brief rendering and refuse-to-spawn

`src/tasks/brief-render.ts` renders `<pack>/briefs/brief.md.tmpl` once, in template
order, with a stable role/project prefix first for prompt-cache reuse. The pack
template owns the fixed section order: role, worker protocol, standing rules,
decisions, goal, scope/locks, context/prior attempt, acceptance, verify, timebox,
forbidden, report. The renderer preserves that order; it does not validate or
reorder an arbitrary replacement template.

`src/tasks/brief-render.ts` supplies role prompt, `AGENTS.md` Conventions plus
manifest standing rules, project protected paths plus role forbidden paths,
decision rows, title/first body paragraph, scope, locks, context excerpts,
acceptance, project-then-ticket verify commands, remaining budget, forbidden
rules, and issue ID. Scope uses project `studio.config.json` role write-scope
overrides or manifest defaults, intersects explicit `files` with that scope,
and removes forbidden matches. These are brief instructions, not an OS write
sandbox. Context excerpts have a 6,000-character allowance; an oversized excerpt
falls back to its anchor/path. The renderer accepts prior-attempt text, but
`src/tasks/runner.ts` currently calls it without retry consolidation.

Unknown placeholders, empty `{{required ...}}` values, unresolved references,
and rendering/storage errors cause `src/tasks/runner.ts` to refuse the spawn
before constructing an adapter. It recovers the claim, projects
`needs-attention`, and records the reason in a `task.escalated` event, with no
harness run telemetry. A worker cannot ask a question: an incomplete brief is a
planning error. Safe recovery retains worktree/locks when output cannot safely
be removed (`src/tasks/runner.ts`, `src/git/worktree.ts`). Route refusals use the same no-spawn
boundary in `src/tasks/runner.ts`.

`storeBrief` in `src/tasks/brief-render.ts` stores successful rendered briefs in
the project state directory as `briefs/issue-<n>-<attempt>.md`, using exclusive
creation and increasing attempt numbers without overwriting audit history.
`src/board/telemetry.ts` owns the project state location (normally under
`~/.orch/<project>/`).

## Per-ticket verify and its trust rule

[ADR-0013](0013-ticket-verify-trust.md) owns the complete trust rule, amending
[ADR-0012](0012-multi-provider-routing.md)'s config-only host verification
boundary. `src/tasks/verify.ts` authorizes ticket argv only as a constrained
extension of an entire coordinator-loaded project verify entry. Added arguments
are limited to repository-relative paths, literal `--`, or plain unsigned
numbers. `src/tasks/plan.ts` checks this during planning; `src/tasks/runner.ts`
checks issue metadata again before executing host checks.

For a completed worker leaving uncommitted changes, `src/tasks/runner.ts` runs
project checks followed by authorized ticket checks in the claimed worktree,
with a five-minute timeout per command through `src/util/exec.ts`. Failure holds
the task for attention and preserves its work. Workers also receive verify
instructions for self-checking in their own permission profile
(`src/tasks/brief.ts`, `src/tasks/brief-render.ts`). This does not add a universal
host-check stage to every possible submission path.

## Cleaned environment and protected verify paths

**Configured verify commands still run worker-written code**, including tests,
package scripts, and imports. That is why both safeguards exist: the cleaned
environment limits inherited credentials during execution, while stronger review
protects changes to how verification runs. As specified in
[ADR-0013](0013-ticket-verify-trust.md), `verifyEnvironment` in
`src/tasks/verify.ts` removes credential-bearing and provider/harness variables;
`src/tasks/runner.ts` passes that environment to host verify subprocesses.
It is not an OS sandbox; retained HOME access can still expose local auth files.

`checkMergeGate` in `src/board/review.ts` requires an accepted explicit
current-head lead-tier approval when changed files match configurable
`protectedPaths`, even if ordinary cross-review is disabled.
`src/config.ts` supplies defaults for package/test-runner/orch configuration;
`src/github/github.ts` observes changed paths, including both rename sides;
`src/git/path-locks.ts` matches concrete filenames via `pathMatchesGlob`.
Unreadable/incomplete observations or head changes block merge. See ADR-0013 for
the exact defaults, overrides, and approval qualifications. This extends the
authorship/review threat boundary in
[ADR-0007](0007-prompt-injection-threat-model.md), without claiming isolation.

## Needs and sensitivity filters

`src/config.ts` accepts replacement `capabilities` arrays on model specs and tier
members, including an empty array. Defaults from `resolveCapabilities` are
Claude `shell, vision`, Codex `shell`, OpenCode `shell`; no model defaults to
web, and model names never imply vision. `src/routing/route-policy.ts` requires
all ticket needs and applies sensitivity independently of the role allowance.
Manifest needs are not automatically appended to ticket needs.

`src/routing/route-policy.ts` resolves explicit ticket sensitivity, then config
default, then `internal` for opted-in tickets/projects. Untouched v1 projects
remain unrestricted. Public adds no sensitivity restriction. Secret allows the
configured families (default `anthropic`, `openai`) for native harnesses and
always excludes OpenCode. Internal uses its configured families for native
harnesses, while OpenCode requires its exact provider/model in
`sensitivity.internal.allow`, regardless of family. Retention verification is
the operator's responsibility.

`src/routing/assign.ts` filters proposals, `src/tasks/service.ts` guards claims,
and `src/tasks/runner.ts` rechecks dispatch. An incompatible unpinned candidate
is skipped so another agent can claim it; an explicitly assigned disallowed
route is escalated without a harness invocation. `src/tasks/cascade.ts` and
`src/tasks/observe.ts` carry requirements into implementation and PR fallback
selection, so a cascade cannot bypass these filters.

## Worker diff scope (owner decision 2026-10-19, #186)

When `pack` is configured and an issue has a `role:` label,
`src/tasks/scope-guard.ts` checks concrete changed paths against the manifest's
`write_scope` union the ticket's `files`. Manifest `forbidden` patterns win over
both allowances. The runtime guard uses manifest scope; per-project overrides
are outside this policy. Each violation names the path and either
`outside write_scope` or `forbidden by <pattern>`.

The runner checks tracked and untracked leftover output before verification and
again before staging. `submit` checks the merge-base branch diff before pushing
or opening a PR. Local diffs disable rename detection and use NUL-delimited
names, preserving deletions and both rename sides. Autopilot observation checks
the complete PR file list and selects the existing escalation step; automated
review repeats the check before starting a reviewer. Unreadable or incomplete
path observations block the handoff. Rejections mark `needs-attention`, comment
the offending paths on the issue or PR, and preserve the worktree and lock.
No pack or no role label retains the existing behavior.

## Enforced path locks

`src/git/lock.ts` extends [ADR-0002](0002-atomic-claim-via-git-ref.md): one atomic
Git transaction claims the issue and normalized path refs under
`refs/orch/lock/path/<sha256>`. Ref blobs retain issue, path, and owner metadata.
A persistent `refs/orch/path-lock-version` compare-and-set serializes overlap
observations, including different globs that intersect; it is a version rather
than a held global mutex. These remain local claims shared by worktrees of one
repository, not a distributed multi-clone lock.

`src/git/path-locks.ts` owns normalization and overlap semantics independently
of current files, protecting future files and directory descendants. Absolute
paths and parent traversal are rejected; portable separators are normalized.
`src/tasks/service.ts` returns ordinary unavailability on contention before issue
projection/worktree setup. `src/git/lock.ts` releases the full owned set through
`release`/`releaseOwned`, covering rollback, merge, abandon, and safe recovery;
retained work retains claims. `src/tasks/reconcile.ts` reports orphaned path refs
without deleting them. Locks are enforced because concurrent scene/binary edits
cannot safely rely on advisory ownership hints.
