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
