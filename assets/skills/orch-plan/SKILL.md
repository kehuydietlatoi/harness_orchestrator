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

## How to decompose

- Prefer **small, independently-shippable** tickets over a few large ones — each should be a focused PR.
- **Order** tickets so references come first; `dependsOn` and `after` may only reference an **earlier** `id`.
- Use **hard prerequisites** (`dependsOn`) when the work requires a predecessor's result. Use **advisory ordering** (`after`) for a preferred sequence. A stalled, blocked, claimed, missing, or closed advisory predecessor never prevents dispatch; direct targeted dispatch ignores advisory ordering. Advisory cycles fall back to issue-number order.
- Give tickets **non-overlapping `files`** where you can — two agents work in parallel, so overlapping ownership causes merge pain. Note unavoidable overlap in the body.
- File ownership is a hint, not proof of independence: check the actual interfaces and required results before choosing `after` instead of `dependsOn`.
- Write each `body` so an agent with no extra context can act: scope, constraints, and a one-line acceptance check.
- Base scope and `files` on the **actual repository structure** you are given, not on assumptions.

## Output contract

Reply with **exactly one** fenced code block tagged `json` and nothing after it — a JSON array of ticket objects:

```json
[
  { "id": "auth-config", "title": "Add OAuth provider config", "body": "Load client id/secret + issuer from env; fail fast on invalid config.", "files": ["src/auth/config.ts"] },
  { "id": "session-mw", "title": "Add session middleware", "body": "Verify the session cookie and attach the user; 401 on protected routes.", "dependsOn": ["auth-config"], "files": ["src/mw/session.ts"] }
]
```

No prose before or after the block.
