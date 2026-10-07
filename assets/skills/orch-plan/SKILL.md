---
name: orch-plan
description: Decompose a feature or goal into an orch tickets.json — small, dependency-ordered GitHub-issue drafts with file-ownership hints. Use when planning work for the orch orchestrator, or when asked to break a goal into tickets/issues.
---

# orch-plan — draft a `tickets.json` for orch

Turn one high-level goal into a **tickets.json**: an ordered array of small,
independently-shippable work items that `orch plan` creates as GitHub issues.

## The ticket schema

Each ticket is a JSON object:

| field | required | meaning |
|---|---|---|
| `id` | recommended | short kebab-case slug other tickets reference in `dependsOn` or `after` |
| `title` | **yes** | the issue title — imperative, one line |
| `body` | recommended | what to build + a short acceptance check (Markdown) |
| `dependsOn` | no | `id`s of **earlier** tickets that must land first |
| `after` | no | `id`s of **earlier** tickets preferred first, without blocking runnable work |
| `files` | no | file/dir ownership hints that minimise overlap between parallel agents |
| `agent` | no | which harness implements it (a configured agent, e.g. `claude` or `codex`) — becomes the `agent:` label |
| `effort` | no | `easy` or `hard` model tier — becomes the `effort:` label; only used together with `agent` |
| `acceptance` | **strongly recommended** | the **definition of done**: checks a test or command can verify — rendered as a checklist in the issue |
| `outOfScope` | recommended | tempting adjacent work this ticket does *not* do, naming the later ticket that owns it |

## How to decompose

- Prefer **small, independently-shippable** tickets over a few large ones — each should be a focused PR.
- **Order** tickets so references come first; `dependsOn` and `after` may only reference an **earlier** `id`.
- Use **hard prerequisites** (`dependsOn`) when the work requires a predecessor's result. Use **advisory ordering** (`after`) for a preferred sequence. A stalled, blocked, claimed, missing, or closed advisory predecessor never prevents dispatch; direct targeted dispatch ignores advisory ordering. Advisory cycles fall back to issue-number order.
- Give tickets **non-overlapping `files`** where you can — two agents work in parallel, so overlapping ownership causes merge pain. Note unavoidable overlap in the body.
- File ownership is a hint, not proof of independence: check the actual interfaces and required results before choosing `after` instead of `dependsOn`.
- Write each `body` so an agent with no extra context can act: scope, constraints, and a one-line acceptance check.
- Base scope and `files` on the **actual repository structure** you are given, not on assumptions.
- **Route** a ticket (`agent` + `effort`) when you are confident who should build it: `hard` for design-heavy, cross-cutting, or risky work, `easy` for mechanical changes. Omit both when unsure — orch's routing judge fills in unrouted tickets. An `effort` without an `agent` is dropped.

## Definition of done

A ticket without a finish line cannot be reviewed to a conclusion: every round a reviewer finds one more real gap,
and the task escalates to a human. So every ticket gets `acceptance` and, where there is tempting adjacent work,
`outOfScope`. orch renders them as the issue's **Definition of done** and **Out of scope** sections, the reviewer
judges against them, and anything beyond them is recorded as a non-blocking follow-up instead of a change request.

- Each `acceptance` item must be **checkable**: name a test, a command and its expected result, an observable output,
  or a specific behaviour — "`npm test` passes and `test/x.test.ts` fails if the edge is removed", not "handles errors well".
- **Close open-ended tickets.** If the title or body says *every*, *all*, *complete*, *comprehensive* or *canonical*, reduce it
  to a closed checklist, or to a machine-checked invariant (a test that fails when something is missing). Worked example:
  "model every orch flow" becomes "a node for every `Step` kind and every lifecycle state (a type-level exhaustive test),
  every edge endpoint exists, every code reference resolves" — and deeper behavioural fidelity is `outOfScope`, owned by
  the later ticket whose scenarios check the model against the real code.
- Prefer 3–6 items. More usually means the ticket should be split.
- `outOfScope` should name the neighbour: "per-scenario narration — #97", not just "polish".

`orch plan` warns (it never blocks) on a ticket with no `acceptance`, or one that reads as open-ended without an item that
names a check. Fix the warning rather than ignoring it.

## The plan brief (interactive sessions)

When the session asks for one, also save a short markdown **plan brief** (under 4000 characters) next to `tickets.json`. orch embeds it in every created issue as a collapsed "Plan context" block, so implementers, reviewers, and the lead's later decisions keep the reasons behind the plan. Cover:

- **Goal** — what the whole plan achieves and for whom.
- **Key decisions** — the choices made while brainstorming, with one-line reasons.
- **Constraints** — what must not change, compatibility, performance or security limits.
- **Rejected alternatives** — what was considered and why not, so nobody re-litigates it.
- **Acceptance** — how to tell the whole plan is done.

Do not write `Depends-on:`/`After:` lines in the brief — ticket ordering belongs in `dependsOn`/`after`.

## Output contract

Reply with **exactly one** fenced code block tagged `json` and nothing after it — a JSON array of ticket objects:

```json
[
  { "id": "auth-config", "title": "Add OAuth provider config", "body": "Load client id/secret + issuer from env; fail fast on invalid config.", "files": ["src/auth/config.ts"], "acceptance": ["`loadAuthConfig()` throws a clear error when the issuer is missing (test)", "`npm test` passes"], "outOfScope": ["token refresh, owned by the session ticket"] },
  { "id": "session-mw", "title": "Add session middleware", "body": "Verify the session cookie and attach the user; 401 on protected routes.", "dependsOn": ["auth-config"], "files": ["src/mw/session.ts"], "agent": "claude", "effort": "hard" }
]
```

No prose before or after the block.
