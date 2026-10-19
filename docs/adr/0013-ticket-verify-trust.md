# ADR-0013: Ticket verification on the host

Accepted, 2026-10-19 (#175). This extends the host verification boundary in
[ADR-0012](0012-multi-provider-routing.md).

Ticket `verify` remains untrusted issue data. For orch to execute it, its argv
must start with an entire coordinator-loaded project `verify` entry. Extra
arguments may only be repository-relative paths (no leading dash, parent
traversal, absolute path, drive/URI colon, or control characters), the literal
`--`, or an unsigned plain decimal number. Planning reports each violation with
the ticket identity and argument; the runner repeats this check against issue
metadata before executing any host checks. Workers receive the argv in their
brief for self-checking inside their own sandbox.

For completed workers leaving uncommitted changes, orch runs project checks
first, then trusted ticket checks, directly with `shell: false`, a five-minute
timeout per command, and cwd fixed to the claimed task worktree. The explicit
environment removes credential-bearing token, API-key, auth, password, secret,
and credential variables, plus every `ANTHROPIC_*`, `OPENAI_*`, `OPENCODE_*`, and
`CODEX_*` variable, case-insensitively. Test-runner environment such as PATH,
HOME/USERPROFILE, SystemRoot, TEMP/TMP, and non-auth NODE variables survives.

Configured commands can still execute worker-written tests on the host. The
merge gate therefore requires a current-head accepted approval explicitly at
tier `lead` for changes matching `protectedPaths`, even when ordinary cross
review is disabled. Defaults cover package.json, vitest.config.*, jest.config.*,
.mocharc*, playwright.config.*, and orch.config.json at any repository depth;
operators can replace the list (including an explicit empty list). Matching is
conservative for whole files, including deletions and both sides of renames.
File-list failures, potential truncation, and a changed head block merge.
Existing family, configured-reviewer, self-review, and revocation rules still
apply; legacy approvals without an explicit tier cannot satisfy this rule.

These controls constrain host execution and require stronger review without
introducing OS-level isolation. Keeping HOME permits tools to read local auth
files, and tests remain executable code: the cleaned environment is not a
sandbox or a guarantee that every credential source is inaccessible.

## Capability and sensitivity routing (#176)

`validateRoute` is the pure policy boundary for role, sensitivity, and model
capabilities. Planning requires a satisfying allowed route and checks an explicit
assignment against the model dispatch would select. Dispatch repeats the check
before constructing an adapter; a refusal marks needs-attention and emits
`task.escalated` without harness invocation or run telemetry. Both implementation
and PR cascades pass issue metadata into `nextHop` so fallback preserves filters.

Model specs and ladder members accept `capabilities`, an explicit replacement
including an empty array. Proven harness defaults are Claude `shell, vision`,
Codex `shell`, and OpenCode `shell`. Model names never imply capabilities;
OpenCode vision models must declare vision. Nobody defaults to web. Needs for
engine, image-gen, and audio-gen are rejected pending tooling in Phases 3-4.

Secret permits only configured `sensitivity.secret.families` (default anthropic
and openai) and always excludes OpenCode. Internal permits configured
`sensitivity.internal.families` (same default) for native harnesses; OpenCode
requires its exact provider/model in `sensitivity.internal.allow`, even when its
family is allowed. Public adds no sensitivity restriction. Explicit ticket
sensitivity wins over `sensitivity.default`, then internal. To preserve v1
projects, tickets without needs or sensitivity remain unrestricted unless the
project config opts in through `sensitivity` or `pack`. Provider retention-term
verification remains an operator responsibility.
