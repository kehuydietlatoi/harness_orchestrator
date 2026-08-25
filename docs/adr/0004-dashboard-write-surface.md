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
local-browser authorization chokepoint, without changing the two GET route
implementations or the loopback bind.

- `POST /actions/suggest` runs the judge in-process and returns
  `{ suggestions: PlanEntry[] }`. It **writes nothing**; a judge failure returns
  `502` (fail-closed) so a bad run never half-routes the board.
- `POST /actions/assign` applies a (possibly human-edited) plan via `applyPlan` +
  `editIssue`, returning `{ writes, skips }`. It is the **only** endpoint that
  mutates. `origin: "brain"` additionally stamps `assigned-by:brain`; `"human"`
  (the default) does not.
- Before handler selection or body reads, every `/actions/*` request must pass
  all of these checks: a loopback peer address, a literal loopback `Host`
  (`127.0.0.1`, `localhost`, or `[::1]`) on the port that accepted the socket,
  an `Origin` matching that Host origin, `X-Orch-Request: dashboard`, and an
  `application/json` Content-Type. Authorization failures return `403`; a
  non-JSON request returns `415`. The server still binds `127.0.0.1` only.

**Trust model:** writes are available only to a same-origin browser page or a
deliberate local HTTP client that supplies the Orch header. The header is not a
secret; its browser-security value is that it forces a hostile cross-origin
page to preflight, while the server exposes no permissive CORS response. The
Host allowlist prevents DNS rebinding from turning an attacker-controlled origin
into a loopback caller. There is still no bearer token, so this remains a
single-user, single-machine surface rather than an off-box API.

## Consequences

- The dashboard is no longer read-only; `/status` and `/` are unchanged, but
  `/actions/*` can now change the board. The AGENTS.md "Dashboard boundary"
  convention is updated to say so.
- **A future tunnel (Phase-2 phone control) MUST add real authentication inside
  the `/actions/*` guard before exposing writes off-box.** The explicit Orch
  header is a CSRF defense, not authentication. This is the single, localized
  place that upgrade lands — the write path is not scattered.
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
  in `--demo`). Like `/actions/assign`, it sits behind the shared action-request
  chokepoint — so future off-box authentication still lands in exactly one place.

The read routes (`GET /`, `GET /status`) remain byte-stable.
