# ADR-0004: Dashboard gains a write surface (locality-trusted)

- Status: Accepted
- Date: 2026-08-24

## Context

Phase-1 shipped the dashboard (`src/server/server.ts`) deliberately **read-only**: it
served `GET /` (the page) and `GET /status` (the board snapshot) and nothing
else, binding `127.0.0.1` only. That boundary was recorded as a convention so no
mutation crept in by accident.

The assignment brain now has a headless **judge** (`runJudge`, ADR-adjacent to
the routing design) that proposes `agent:`/`effort:` routing, and a deterministic
**writer** (`applyPlan` → `editIssue`) that applies a plan. To let a human route
the board from the browser — see the judge's suggestions, override a row, or
assign manually, then apply — the dashboard must be able to (a) run the judge and
(b) write labels. Both are mutations the read-only surface forbids.

## Decision

Add a minimal **write surface** under `POST /actions/*`, guarded by a single
locality chokepoint, without changing the two GET routes or the loopback bind.

- `POST /actions/suggest` runs the judge in-process and returns
  `{ suggestions: PlanEntry[] }`. It **writes nothing**; a judge failure returns
  `502` (fail-closed) so a bad run never half-routes the board.
- `POST /actions/assign` applies a (possibly human-edited) plan via `applyPlan` +
  `editIssue`, returning `{ writes, skips }`. It is the **only** endpoint that
  mutates. `origin: "brain"` additionally stamps `assigned-by:brain`; `"human"`
  (the default) does not.
- Every `/actions/*` request must pass `isLoopback(req.socket.remoteAddress)`
  before any side effect; a non-loopback caller gets `403`. The server still
  binds `127.0.0.1` only — `isLoopback` is belt-and-suspenders.

**Trust model:** the machine's OS boundary is the sole authorization. There is no
token today because nothing off-box can reach a loopback-bound port. This is
appropriate for a single-user, single-machine daily-use tool.

## Consequences

- The dashboard is no longer read-only; `/status` and `/` are unchanged, but
  `/actions/*` can now change the board. The AGENTS.md "Dashboard boundary"
  convention is updated to say so.
- **A future tunnel (Phase-2 phone control) MUST add a token check inside
  `isLoopback`/the `/actions/*` guard before exposing writes off-box.** Exposing
  the current surface through a tunnel without that check would let any reachable
  client mutate the board. This is the single, localized place that upgrade lands
  — the write path is not scattered.
- ADR-0003 (cross-review is a process guarantee) is unaffected: routing writes
  `agent:`/`effort:` labels only; the merge gate and its `reviewed-by:` invariant
  are untouched.
- The judge runs in-process (like `buildSnapshot`), so `orch serve` now needs the
  `claude` CLI available to answer `/actions/suggest`; a missing/failed judge is
  handled as `502`, not a crash.

## Addendum (2026-08-25): the Plan panel

The same pattern was extended to **planning** — creating issues from a
`tickets.json` — without changing the trust model:

- `POST /actions/plan-preview` parses + validates a ticket draft via the pure
  `parseTickets`/`resolvePlan` and returns the resolved plan. It **writes
  nothing**; a malformed/invalid draft is a `400`.
- `POST /actions/plan-create` is the **second** (and only other) mutating route.
  It re-validates and refuses (`400`) on blocking errors, then creates the issues
  via the injectable `ServerDeps.createIssues` (default `createFromPlan`, faked
  in `--demo`). Like `/actions/assign`, it sits behind the one `isLoopback`
  chokepoint — so the future-tunnel token check still lands in exactly one place.

The read routes (`GET /`, `GET /status`) remain byte-stable.
