# Work-item evidence — `POST|GET /tasks/:taskId/evidence` (A2-274, MUN-EVIDENCE)

## The gap this closes

A2-P4 ends with an executor — ARAS — that has finished a work item and holds a
`ReadinessReceipt/v1` for it. Until this route there was nowhere on the work
item to put that receipt. The only write an agent key had on a task besides the
status move was `POST /tasks/:taskId/comments` (MUN-0046), and a comment is free
text: a later reader cannot tell a receipt from a sentence describing one, and
nothing in it binds the bytes it names. "The evidence is in the PR" is not
evidence; a locator plus a digest is.

This route records the three things a later reader needs — **where** the
artefact is, **what** it is, and **which bytes** were meant — attributed to the
agent that attached it.

## Contract — `WorkItemEvidenceAttachment/v1`

Request body (camelCase, as `CreateTaskDto`; this body is written by an agent
against this API, not copied from another tool's report):

```json
{ "uri": "https://github.com/Arcanada-one/muneral/blob/main/receipts/readiness-a2-274.json",
  "sha256": "5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8",
  "contentType": "application/json" }
```

- `uri` — an **absolute** URI: a scheme, then no whitespace and no control
  characters, at most 2048 characters. A bare path (`receipts/graph/x.json`) is
  refused on purpose: it resolves only for a reader who already knows which
  machine and which checkout wrote it, which is exactly what a cross-agent
  pointer cannot assume. A `userinfo` component (`https://user:secret@host/…`)
  is refused rather than stored — this string is written to the table **and** to
  the activity payload, both of which are read back and exported.
- `sha256` — 64 **lowercase** hex characters, no `sha256:` prefix. The algorithm
  is the column, not the value. (`tasks.contract_digest`, A2-267, is the other
  convention, and deliberately so: that one quotes a KC2 digest string verbatim
  from Argana.)
- `contentType` — a lowercase media type, optionally with `; key=value`
  parameters, at most 128 characters. Lowercase for the same reason the digest
  is: the stored value is compared byte for byte when a repeat is checked
  against it, so one media type must have one spelling.

Answer — the same object for POST and for each element of the GET list:

```json
{ "schema": "WorkItemEvidenceAttachment/v1",
  "evidence_id": "…", "task_id": "…", "uri": "…", "sha256": "…",
  "content_type": "application/json", "created_by_agent_id": "…",
  "created_at": "2026-09-24T17:20:11.004Z", "idempotent": false }
```

`idempotent` is on the POST answer only. It is a fact about **one call**, never
about the stored row, so the GET list does not carry it.

`GET /tasks/:taskId/evidence` answers `{task_id, total, evidence: [...]}`,
oldest first.

| status | when |
|---|---|
| 201 | the first attachment of this digest on this task; `idempotent: false` |
| 200 | the same claim repeated: the stored record, `idempotent: true`, no write |
| 400 `EVIDENCE_SHA256_MALFORMED` | the digest is not 64 lowercase hex |
| 400 `EVIDENCE_URI_MALFORMED` | not an absolute URI, or over 2048 characters |
| 400 `EVIDENCE_URI_HAS_CREDENTIALS` | the uri embeds a userinfo component |
| 400 `EVIDENCE_CONTENT_TYPE_MALFORMED` | not a lowercase media type |
| 403 `EVIDENCE_AGENT_KEY_REQUIRED` | a JWT tried to attach (it may read) |
| 403 | an agent key that neither created the task nor is assigned to it — and the same answer for a task id that does not exist |
| 409 `EVIDENCE_DIGEST_CONFLICT` | this digest is already attached with a different uri or media type |
| 401 | no credential, or a key that is not a `mun_sk_` key |

A malformed **value** always carries a machine-readable `code`; that is why
these rules live in `src/tasks/evidence/task-evidence.errors.ts` and not as
class-validator decorators. The global pipe's own 400 — a missing field, a
number where a string belongs, an undeclared property under
`forbidNonWhitelisted` — carries no `code` and cannot be made to without
changing the pipe for every route in the API.

## The digest is the identity

`UNIQUE (task_id, sha256)` is the whole idempotency mechanism. An unattended
executor that lost its answer and retries gets the stored row back (200) rather
than a second record of one artefact; two concurrent first calls are serialised
by the index and the loser re-reads and answers the same way. Measured: removing
the service's `existing` pre-check alone leaves the suite green — the index plus
the `P2002` catch carry this on their own, and the pre-check is an optimisation.

A repeat that names the same digest with a **different** `uri` or
`contentType` is not a retry: it is a disagreement about what those bytes are.
Answering 200 with the stored row would tell the caller its values were recorded
when they were not, and 201 would need a second row for one artefact. Both hide
the disagreement, so the route reports it (409, with the stored and the
attempted values side by side).

## What the server does NOT do

It never fetches the `uri` and never checks that the bytes there hash to
`sha256`. What is stored is a **claim** about an artefact, attributed to the
agent that made it. Nothing here may be read as "the evidence was checked" — a
verification step, if one is ever added, is a separate act with its own record.

## Authorisation

Both routes are marked `@AgentScope('task-evidence')`. The key's agent must have
**created** the task or be **assigned** to it, inside its own workspace
(`assertOwnTask`) — deliberately not assignment-only: an executor that
registered its own work item through `POST /tasks` (MUN-0045) never gets a
`task_agents` row for it, and the assignment-only rule would refuse it on
exactly the task whose receipt it holds. That is the MUN-0054 measurement, where
every work item the fleet registered on 2026-09-13 answered 403 to the key that
created it.

Its own scope name rather than reusing `'task'`, as with `'task-redaction'`:
attaching evidence is a different act from commenting, and an allowlist entry
that can be narrowed or revoked on its own is worth one enum value.

The POST additionally refuses a JWT. `created_by_agent_id` is NOT NULL and names
an agent; a human has no agent id, so a human-attached row could exist only with
that column relaxed — and an attachment nobody is named for is precisely the
unattributable evidence this table exists to prevent. Attribution is `req.actor`
from the credential (`ActorInterceptor`); the DTO carries no actor field a
caller could use to claim another principal. Reading the list with a JWT is what
the dashboard does.

## What is written, atomically

1. `task_evidence_attachments` — the row.
2. `activity_log` — one entry, action `task:evidence_attached`, payload
   `{evidence_id, uri, sha256, content_type}`, actor from the credential.

Both in one transaction: an attachment committed without its audit entry would
be a state change with no record of who made it. Nothing else on the task
changes — not the status, not the revision, not a field value, so no field-state
recompute and no KB change-registry bump.

`ON DELETE CASCADE` with the task, as `task_redactions`: deleting a work item
takes its evidence rows with it, and the activity entries (task_id `SET NULL`)
are what outlive it. `ON DELETE RESTRICT` on the agent: an attachment whose
author had been deleted would be evidence nobody attached.

## Measurements

`apps/api/test/task-evidence.e2e.spec.ts` (34 cases, real Postgres, main.ts's
own pipe) and `task-evidence.migration.spec.ts` (7). Each half was reverted and
measured red before it was trusted green — the idempotency handling, the unique
constraint (dropped in the database), the guard's ownership check, the digest
format rule and the conflict comparison. See the card's run directory.
