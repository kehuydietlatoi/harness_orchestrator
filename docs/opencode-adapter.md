# OpenCode adapter for orch

The implemented contract targets OpenCode **1.19.3**. The current behavior below
comes from [the adapter](../src/adapters/opencode.ts), [argv/reducer](../src/adapters/opencode-events.ts),
and [task runner](../src/tasks/runner.ts). Historical observations are retained in
[Spike (2026-10-18)](#spike-2026-10-18); they do not guarantee current endpoint availability.

## Invocation

```text
argv:  run --format json -m <provider/model> [--variant <effort>] [-s <sessionID>]
stdin: UTF-8 prompt, then close
cwd:   task worktree (runTask), caller's checkout (runHeadless)
env:   OPENCODE_CONFIG=<unique per-run file outside the worktree>
       OPENCODE_DISABLE_PROJECT_CONFIG=true
spawn: shell:false, windowsHide:true
```

An explicit provider/model is required. `adapters.opencode.cmd` overrides executable
resolution; otherwise orch resolves `opencode.exe` with `where` on Windows or
`opencode` with `command -v` on POSIX. Use a native executable, not an npm Windows
shell shim. Prompts never go in argv. The builder supports `--title`, but the
adapter does not supply it. `ModelSpec.effort` is passed as `--variant`; provider
effects remain unverified. Only resume adds `-s`; `--auto` is never passed.

Inherited credentials are stripped with the shared verification rule. For a
provider requiring an API key, configure e.g.
`"adapters": { "opencode": { "env": ["OPENROUTER_API_KEY"] } }` to restore that
variable only when set. The default list is empty, suitable for Zen free models.
GitHub tokens are excluded even when listed. Orch's configuration variables are
applied after cleaning; see [ADR-0013](adr/0013-ticket-verify-trust.md).
[spawnLogged](../src/util/spawn.ts) appends both streams to the log, closes stdin,
and kills on timeout (Windows uses direct `taskkill /T /F`). A long tool call can
be silent until completion, so event gaps are not a liveness signal.

`runTask` reports success only for reducer outcome `completed` and returns the
session ID (falling back to the supplied resume ID). The runner persists it via
[sessions](../src/tasks/sessions.ts) for later fix rounds. `runHeadless` returns
the last text and raw log range and forces a nonzero code for an incomplete or
failed reduction. Interactive planning and session export are not implemented
adapter capabilities.

## Events and outcome classes

JSONL is split on CRLF or LF; non-JSON diagnostic lines are ignored. Only bytes
appended by the current invocation are reduced, preventing old failures in an
append-only log from poisoning a retry.

| Event | Fields consumed |
|---|---|
| First typed event | `sessionID` |
| `step_start` | Increments requests |
| `text` | `part.text` replaces result text |
| `step_finish` | Last `part.reason`; sums `tokens.input`, `tokens.output`, `tokens.cache.read`, `cost` |
| `error` | `error.data.statusCode`, `isRetryable`, `responseHeaders` |
| `tool_use` | Not terminal; a tool error can recover to a final stop |

The reducer applies these rules in order:

1. Process timeout: `timedOut`.
2. Error events: `quota` for 429; `endpoint-unavailable` for status >=500 or
   `isRetryable:true`; `auth` for 401/403; otherwise `failed`. Across errors,
   that same order chooses the highest priority. A retryable 401 is therefore
   endpoint-unavailable.
3. Nonzero process exit and no typed events: `spawn-failure`.
4. Last step reason is not `stop`, or the combined log contains `auto-rejecting`:
   `incomplete`, even with exit zero.
5. Otherwise: `completed`. The reducer does not independently reject a nonzero
   exit if events end in `stop`; the endpoint ping additionally requires exit zero.

`auth` is a classification, not an implemented adapter-wide unhealthy/escalate-once
policy. Ordinary unsuccessful implementations follow failed-run recovery and
the needs-attention hold. Completion also does not prove a useful code change:
the coordinator separately checks work and submission state.

## Per-run configuration and permissions (#138 / #142)

Each invocation creates a unique temporary directory under orch's project state
directory and writes a `config.json` with mode 0600 where supported. Its
`OPENCODE_CONFIG` file is removed in `finally` after the child settles, including
spawn exceptions. State must resolve outside the canonical checkout: an
`ORCH_HOME` inside it, including through a symlink, is rejected.

Both writable and read-only profiles grant:

```json
{ "external_directory": { "*": "deny", "<canonical-absolute-worktree>/*": "allow" } }
```

The grant uses the invocation's real checkout path with forward slashes; it is
run-scoped. Paths containing `*` or `?` are rejected because the permission matcher
cannot escape them. This permits bash with an explicit worktree `workdir` without
an external-directory prompt.

OpenCode 1.19.3 merges project permissions after `OPENCODE_CONFIG`. Orch therefore
sets `OPENCODE_DISABLE_PROJECT_CONFIG=true` and clears inherited
`OPENCODE_CONFIG_CONTENT`, `OPENCODE_CONFIG_DIR`, and `OPENCODE_PERMISSION`.
Repository `opencode.json`, `opencode.jsonc`, and `.opencode` configuration,
agents, plugins, and commands are unavailable to workers. Configure providers in
trusted user/global settings. These filenames describe OpenCode discovery inputs,
not files required in this repository.

Profiles use allow/deny, never ask. Both deny bash by default, allow
`git status*`, `git diff*`, `git log*`, `rg *`, and `ls*`, deny `git push*`, and
deny webfetch. Writable runs allow edits; read-only runs deny edits. Writable
runs additionally allow safely expressible literal configured verify commands.
There is no general git commit allowance. These are OpenCode policies, not an OS
filesystem sandbox; global config remains trusted operator input. See
[ADR-0007](adr/0007-prompt-injection-threat-model.md) for the trust boundary and
live precedence evidence.

## Verification and coordinator completion (#139)

The `verify` field in the coordinator-loaded [orch.config.json](../orch.config.json)
is an array of argv arrays, for example `[["node", "--version"]]`.
Commands never come from ticket text. After a completed implementation that has
not submitted and has no commits ahead, orch checks for dirty/untracked output.
For such output, orch runs each configured command in the task worktree via
[exec](../src/util/exec.ts), shell false, with a five-minute timeout per command.
Then it stages and commits with the issue title/number and worker/model attribution
and follows normal submission. An empty verify list permits completion without
local checks; clean/no-commit output follows the existing recovery path.

Verification failure retains the worktree and claim lock, projects needs-attention,
and comments the failing argv and output tail. Existing commits take the normal
submission path without this coordinator completion check.

Workers can also self-check: writable OpenCode profiles allow a verify command's
literal space-joined spelling only when every argument matches
`[a-zA-Z0-9_./:=@+-]+`. Shell quoting, whitespace inside arguments, and glob syntax
are not widened into permissions. Read-only profiles get no verify allowance;
push remains denied. Worker self-checks do not replace orch-run verification.

## Health checks, cooldowns, and quota (#123 / #141)

`healthCheck()` checks executable availability and an exit-zero `--version`;
it does not enforce version 1.19.3 or ping a model. Before claiming OpenCode work,
[endpointHealthy](../src/board/health.ts) gates targeted dispatch and `claimNext`'s
async eligibility predicate. It sends `Reply OK` on stdin using a read-only run
with a 60-second timeout. Success requires exit zero, `completed`, and trimmed
result text exactly `OK`.

Results persist by slug in project `health.json` for ten minutes; concurrent
same-project/slug probes share one promise. Existing endpoint cooldowns skip the
probe. Failure, including a spawn error or timeout, cools `opencode:<provider/model>`
for **10 minutes** in `availability.json`. Other endpoints remain eligible;
Claude/Codex bypass this model probe.

The runner can advance an unclaimed todo to the next configured ladder member.
Only successful relabeling emits `cascade.hop`; without a hop the todo is unchanged.
No implementation run telemetry or ticket request charge is recorded for a
pre-claim ping, although the provider request itself consumes quota.

For in-run refusals, [usage-limit detection](../src/adapters/usage-limit.ts) reads
error-shaped events: 429 uses `retry-after` (seconds or HTTP date), then
`x-ratelimit-reset` (Unix seconds), else ten minutes. Server/retryable errors use
ten minutes. [Availability](../src/board/availability.ts) clamps stored cooldowns
to one minute through twelve hours. The reducer itself only extracts numeric
retry-after seconds; the log detector owns full reset handling. If log detection
is unavailable, an outcome-only quota fallback uses the general one-hour default;
an endpoint-unavailable fallback still uses ten minutes.

Requeue/cascade after a failed run requires safe worktree removal and lock release;
retained work follows failed recovery instead. Safe requeues avoid needs-attention.
With no ladder hop, the coordinator waits for endpoint availability. OpenCode's
default `pricingMode` is `quota`: implementation telemetry records zero dollars,
preserves step-start requests (at least one per invocation), and increments daily
UTC endpoint counts through [quota accounting](../src/board/quota.ts).

## Tests and remaining unverified follow-ups

The copied evidence already lives in [test/fixtures/opencode-1.19.3](../test/fixtures/opencode-1.19.3/).
[Reducer tests](../test/opencode-events.test.ts) snapshot all five JSONL fixtures
and the auto-rejection stderr companion and test argv/outcome edge cases.
[Adapter tests](../test/opencode-adapter.test.ts) cover config isolation, cleanup,
permissions, log ranges, and health checks. Opt-in live tests cover project config
precedence, bash with explicit workdir, and a toy edit. Run with
`ORCH_OPENCODE_LIVE=1 npm run test -- test/opencode-adapter.test.ts` (PowerShell:
set `$env:ORCH_OPENCODE_LIVE='1'` first). On Windows, `ORCH_OPENCODE_CMD` can name
the native executable. The precedence test pins 1.19.3; model tests need network.
Re-run before upgrading the permission contract.

Still unverified: a **real 429 envelope** (current coverage is synthetic),
**OpenRouter authentication and runs**, and **per-model `--variant` effects**.
Local Ollama model quality and downloads were not tested. Whether session export
always begins with JSON also remains unverified; orch does not consume exports.
Server mode remains a possible future direction, not the adapter transport.

## Spike (2026-10-18)

The following original findings were recorded on Windows 11 with OpenCode
**1.19.3** (`npm i -g opencode-ai@1.19.3`, publisher `thdxr`), Codex 0.160.1,
and Claude Code 2.1.285. They are dated observations, not current service promises.
Fixture filenames below are relative to the linked fixture directory above.

### Verdict

`opencode run --format json` was workable as a headless worker: JSONL with
session IDs, per-step tokens, resume, stdin prompts, per-run permissions, and
Windows process-tree termination. Two surprises required explicit handling:
ask permissions silently stopped with exit zero, and free endpoints could fail
after long internal retries (82 seconds for a 503).

### What was verified

| # | Probe | Result |
|---|---|---|
| 1 | Zen free models visible without login | `opencode models opencode` lists 12 free slugs (big-pickle, deepseek-v4.1-flash-free, glm-5.3-flash-free, nemotron-*, …) |
| 2 | Toy bug fix, `deepseek-v4.1-flash-free` | exit 0, 25 s, 12 events (bash → read → edit → text), file fixed — `success-edit.jsonl` |
| 3 | Same task, `glm-5.3-flash-free` | exit 1 after 82 s; single `error` event, `statusCode 503`, `isRetryable: true` — `error-503-retryable.jsonl`. A listed model is not necessarily up. |
| 4 | Resume with `-s <sessionID>` | same session ID; model remembered the prior change — `resume-session.jsonl` |
| 5 | `AGENTS.md` in cwd | read automatically (rule followed) |
| 6 | Permission `ask` in headless | auto-rejected, stderr `! permission requested: bash (...); auto-rejecting`; **the run then stops**: last `step_finish.reason = "tool-calls"`, no final text, **exit 0** — `ask-auto-rejected-early-stop.jsonl` + `ask-auto-rejected-early-stop.stderr.txt` |
| 7 | Permission `deny` | tool returns an error to the model, which continues and ends normally (`reason: "stop"`, explains it was blocked) — `deny-then-stop.jsonl` |
| 8 | `OPENCODE_CONFIG=<file outside the worktree>` | honoured (permissions applied) |
| 9 | Prompt on stdin (no message arg) | works |
| 10 | 36k-char prompt as argv | fails: "Argument list too long" (exit 126) → always use stdin |
| 11 | Spawn via the npm `.cmd`/sh shim with `shell: true` | quoting broke the prompt, immediate exit 1 → spawn `opencode.exe` directly, `shell: false` |
| 12 | `taskkill /PID <opencode.exe> /T /F` during a running bash tool | opencode and the `node` command it started both gone; no orphans |
| 13 | Events during a long tool call | none until the tool finishes → liveness needs a timeout, not event gaps |
| 14 | Two concurrent runs (shared `~/.local/share/opencode/opencode.db`) | both exit 0 with correct output |
| 15 | `opencode export <sessionID>` | JSON `{info, messages}` with model, tokens, cost, permission — usable for transcript-based verification |
| 16 | `opencode serve --port N` | up in ~1 s; OpenAPI at `/doc` (162 paths) incl. `/session`, `/session/{id}/prompt_async`, `/session/{id}/abort`, `/permission/{requestID}/reply`, `/event`, `/api/session/{id}/wait` |
