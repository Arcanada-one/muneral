# Task redactions — `POST /tasks/:taskId/redactions` (MUN-0049)

## The gap this closes

The Scrutator `muneral-kb-sync` job scans every task before it is written to
the knowledge base and refuses one that carries secret-shaped material. It
names the refusal by *(rule, sha256 of the matched span)* and never by the
cleartext. Three imported `datarim-history` tasks carried such a span in their
**title**; every sync run named them and exited 1. No Muneral route rewrote a
title or a description (`PATCH /tasks/:taskId/status` and the checklist routes
are the only task PATCHes; a migration re-import never rewrites either field),
and writing to the database directly is forbidden. This route is the
narrowest thing that closes that gap.

## Contract

Request body (snake_case, the names the scanner's blocked-task report uses):

```json
{ "field": "title", "span_sha256": "<64 hex>", "rule": "vault-token-hvs",
  "replacement": "[REDACTED vault-token-hvs sha256:ceaf15b0b8589045 — removed 2026-09-13 KBSYNC-0]" }
```

- `field` — `title` or `description`.
- `rule` — one of the six critical kb-sync rules, vendored in
  `src/tasks/redactions/secret-rules.ts` from Scrutator
  `c08fe654e50c11fcafca31420647e32b6c65450b` (source sha256 in the file header).
- `span_sha256` — sha256 of the span the scanner reported.
- `replacement` — free text, 1–512 characters, refused (400
  `REPLACEMENT_NOT_CLEAN`) if any rule or the entropy rule fires on it.

The server runs the named rule over the **current** field value, keeps the
match whose sha256 equals `span_sha256`, and replaces every identical
occurrence of exactly that span. The caller never sends the secret and never
receives it: the response, the `task_redactions` record and the activity
payload carry `previous_value_sha256`, `new_value_sha256`, the span hash, the
rule, the replacement and the occurrence count. Nothing else on the task
changes — not the status, not the revision, not the rest of the field.

Answers:

| status | when |
|---|---|
| 201 | first redaction of (task, field, span): the record, `idempotent: false` |
| 200 | a repeat of the same triple: the stored record, `idempotent: true`, no write |
| 400 | malformed body, unknown rule, replacement the scanner would block |
| 404 | no such task (JWT); an agent key gets 403 for both unknown and unassigned, as on every scoped route |
| 409 `SPAN_NOT_FOUND` | the rule finds no span with that hash in the current value (`other_spans_of_rule` says how many it did find) |

## Authorisation

Marked `@AgentScope('task-redaction')`: an agent key must be assigned to the
task inside its own workspace — the same check as `'task'` — but under its
own allowlist name, so the one route that rewrites a field can be narrowed or
revoked without touching the read, comment and status routes. A JWT passes
as on every task route. Attribution is `req.actor` from the credential.

## What is written, atomically

1. `tasks.<field>` — the redacted value; `TaskFieldStateService.recompute`
   keeps the field-change hash/version and the task ETag truthful.
2. `task_redactions` — one row, unique on (task, field, span_sha256); hashes
   only, cascades with the task.
3. `activity_log` — action `task:redacted`, payload of hashes and the
   replacement text; `task_id` is SET NULL on task delete, so this is the
   audit record that outlives the task.

The `muneral_kb_tasks_changed` trigger bumps the KB change registry on the
task update, so the next kb-sync run re-scans the task and, with the span
gone, syncs it.
