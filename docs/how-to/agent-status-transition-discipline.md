# How to keep Muneral task status in step with agent progress (MUN-0068)

Progress narration in `POST /tasks/:taskId/comments` is not a status change.
The board and digests read `task:status_changed` from `PATCH /tasks/:taskId/status`.
A comment-only close leaves the card stale.

This how-to is the Muneral author surface for status-transition discipline. It
binds agent briefs, launch templates, and any future merge/close automation that
touches Muneral. Route mechanics stay in
[`apps/api/docs/agent-status-transitions.md`](../../apps/api/docs/agent-status-transitions.md).
Acceptance evidence rules stay in the workspace mandate
`documentation/mandates/task-lifecycle-and-acceptance.md` (DEC-AUP-0168).

## Remeasured defect (do not invent counts)

Parent hygiene task `407fb312-0a8e-4319-8d0b-5ceea5ad19f4`, activity read through
`GET /tasks/{id}/activity?limit=500` with pagination until `total` was covered
(remeasured 2026-11-08):

| action | count |
|---|---|
| `comment` | 515 |
| `task:status_changed` | 1 (`todo` → `in_progress` only) |
| `task:created` | 1 |
| **total** | **517** |

Agents narrated progress as comments without stepwise `PATCH /tasks/{id}/status`.

## Required author surfaces (AC1)

These three surfaces MUST require the same stepwise status rule. Ship the
verbatim fragment below into each one that your lane owns; do not replace a
comment with a status move story.

### Verbatim fragment for COMMON-RULES / author-brief / `launch_agent` first prompt

```text
Status discipline: narrating progress in Muneral comments is not a status change.
Use stepwise PATCH /tasks/{id}/status (todo → in_progress → review → done; one
step per call). Before review, post criterion-mapped evidence as Muneral CONTENT
for every numbered acceptance criterion (PASS, FAIL, or NOT_MEASURED — never
promote NOT_MEASURED to PASS). Session close, PR merge narration, and comment-only
handoffs do not move status. Verify the transition in activity
(task:status_changed) before claiming review or done.
```

- **COMMON-RULES** (fleet ops): keep the existing DEC-AUP-0168 bullets and add the
  fragment so comment-only progress is explicitly refused.
- **Author briefs**: include the fragment in every worker brief that owns a
  Muneral task.
- **`launch_agent.py` first prompt**: the default worker lifecycle line must keep
  criterion-mapped evidence before review and must include the fragment (or an
  equivalent that retains every MUST above).

## Stepwise moves and evidence before `review`

Allowed happy path for finished work:

1. `todo` → `in_progress` when execution starts (API + activity readback).
2. Do the work. Comments and evidence attachments may accompany work; they do
   not replace status.
3. Before requesting `review`: post Muneral CONTENT that maps every numbered
   acceptance criterion to evidence and a tri-valued verdict
   (`PASS` / `FAIL` / `NOT_MEASURED`).
4. `in_progress` → `review` only after that CONTENT exists.
5. Independent review records exact-head `PASS` / `FAIL` / `NOT_MEASURED` per
   criterion.
6. `review` → `done` only after the applicable mandate checklist is recorded as
   CONTENT and Done-means are met. `done` is reachable only from `review`
   (`TASK_TRANSITIONS`); `todo → done` is refused.

`NOT_MEASURED` is a third verdict. It is never PASS and never silently promoted.

## Automation remasurement (AC2)

Remeasured on Muneral `main` tip used for this change and on the named host
author surfaces:

| Surface | Emits or verifies `PATCH /tasks/{id}/status`? | Notes |
|---|---|---|
| `.github/workflows/dependabot-auto-merge.yml` | No | Merges Dependabot PRs; no Muneral API call |
| Other `.github/workflows/*` | No Muneral status PATCH found | CI/admission only |
| Host `launch_agent.py` | No | Starts sessions; does not PATCH status |
| Host Orca `terminal close` path (as consumed by briefs) | No Muneral status PATCH in this repo | Session close ≠ task completion |

**Rule when a writable hook does exist:** it MUST emit a status transition or
run the offline verifier below against sanitized activity and refuse
comment-only close. Do not add a fake merge/close hook in this repository when
none exists; add the verifier so a future hook can fail closed.

Offline verifier (no network, no database):

```sh
node scripts/reporting/verify-required-status-transition.mjs sanitized-required-transition.json
```

See [`scripts/reporting/README.md`](../../scripts/reporting/README.md).

## Delivery constraints (AC4)

Ship this discipline as docs/tooling through PR/CI in authorized repositories.
Do not write production Muneral rows through SQL. Status moves use
`PATCH /api/v1/tasks/:taskId/status` only.
