# Agent Read Loop — Field Change Tracking

Agents poll for task changes using three HTTP calls per cycle.

## 1. GET /tasks/:taskId/field-changes

Authenticates with API key (Bearer token). Returns per-field change status.

> **MUN-0043 — workspace boundary.** This route and `field-ack` used to accept any
> valid API key for any task id, with no ownership check, so a key issued in one
> workspace could read another workspace's task title, description, status and
> priority. Both routes now require the task to be in the **agent's own
> workspace**; a task elsewhere answers `404`, the same answer an id that does not
> exist has always given. Inside its own workspace an agent may still poll a task
> it is not assigned to — that is unchanged on purpose, because unattended loops
> depend on it, and narrowing it further needs a measurement of who actually
> calls it rather than a guess.


```http
GET /tasks/550e8400-e29b-41d4-a716-446655440000/field-changes?agentId=<agent-id>
Authorization: Bearer mun_sk_<key>
```

Response:

```json
{
  "taskId": "550e8400-...",
  "etag": "a3f2d8c...",
  "fields": [
    { "field": "title", "version": 3, "hash": "abc123...", "value": "Fix login bug", "changed": true },
    { "field": "status", "version": 2, "hash": "def456...", "value": "in_progress", "changed": false }
  ],
  "activity": {
    "field": "__activity__",
    "changed": true,
    "latestActivityId": "uuid-latest",
    "lastSeenActivityId": "uuid-prev"
  }
}
```

`changed: true` means this field has a newer version than the agent last acknowledged.

## 2. POST /tasks/:taskId/field-ack

Mark fields as read. The agent advances its watermark to the current version.

```http
POST /tasks/550e8400-e29b-41d4-a716-446655440000/field-ack
Authorization: Bearer mun_sk_<key>
Content-Type: application/json

{
  "agentId": "<agent-id>",
  "fields": [
    { "field": "title", "version": 3 },
    { "field": "__activity__", "version": 0 }
  ]
}
```

Response: `204 No Content`

`body.agentId` must equal the authenticated agent ID — mismatches return `403`.
Unrecognised field names return `400`.

## 3. GET /tasks/:taskId (ETag check)

Check if the task has changed since last fetch using the strong ETag.

```http
GET /tasks/550e8400-e29b-41d4-a716-446655440000
Authorization: Bearer mun_sk_<key>
If-None-Match: "a3f2d8c..."
```

If the field state is unchanged: `304 Not Modified` (no body).
If changed: `200 OK` with the task **row** and a new `ETag` header.

> **MUN-0054 — "full task object" used to be written here, and it misled a
> reader into exactly the wrong inference.** This route returns the task's own
> columns and nothing else: no `dependencies`, no `blockedBy`, no `checklist`,
> no `comments`. An executor read the absent dependency key as an empty one
> (`.get("dependencies") or []`) and declared 254 blocked-or-not tasks ready.
> Both the `200` and the `304` now carry
> `X-Muneral-Dependencies: not-in-body; see /tasks/<id>/readiness` — the `304`
> especially, because a poller on this loop may never see a `200` again.
> The full field list and the readiness routes are in
> [`agent-task-contract.md`](agent-task-contract.md).

The ETag is a SHA-256 hex digest of sorted `field:version` pairs.

## Reading and moving the task with the agent key (MUN-0043)

Until MUN-0043 the three calls above were the only `/tasks/*` routes an API key
could reach: `TasksController` was JWT-only, so a valid `mun_sk_` key was
answered `401` even for the task the agent had just been assigned. An unattended
executor had to borrow a human's 15-minute access token to read its own card or
to move it along.

Three routes now accept either credential, **scoped to the agent's own
assignments**:

| route | an agent key gets |
|---|---|
| `GET /tasks/:taskId` | the task, if the agent is assigned to it (`task_agents`) — otherwise `403` |
| `GET /tasks/project/:projectId` | only the tasks in that project the agent is assigned to; `404` if the project is not in the agent's workspace |
| `PATCH /tasks/:taskId/status` | the transition, if the agent is assigned to the task — otherwise `403` |

## Creating a task with the agent key (MUN-0045)

`POST /tasks` was closed to every agent key — even a well-formed request got
`403`, the same default-deny answer any unmarked route gives, so an agent could
not register the very work it was about to execute. It now accepts an agent key
too, **scoped to the agent's own workspace** (not to an assignment — the task
being created is what the agent would be assigned to next):

| route | an agent key gets |
|---|---|
| `POST /tasks` | creates the task, if `projectId` in the body names a project in the agent's own workspace — otherwise `404`, the same answer a project id that never existed gets |

The created task is attributed to the calling agent regardless of what the
request body claims: `createdById`/`actorType` come from the credential, never
from the body, and there is no field on the create request that names an owner
at all.

## Commenting with the agent key (MUN-0046)

`POST /tasks/:taskId/comments` carried the same omission MUN-0045 fixed on
`POST /tasks`: an unmarked route, so a well-formed request from a valid agent
key got `403` regardless of assignment. It now accepts an agent key, **scoped
to the agent's own assignment** — the same `'task'` scope `GET /tasks/:taskId`
and `PATCH /tasks/:taskId/status` already use, since posting a comment is an
act on one specific task, not a workspace-wide write:

| route | an agent key gets |
|---|---|
| `POST /tasks/:taskId/comments` | posts the comment, if the agent is assigned to the task — otherwise `403` |

The comment is attributed to the calling agent regardless of what the request
body claims: `AddCommentDto` carries only `body`, and the actor comes from the
credential (`req.actor`, via `ActorInterceptor`), never from the request.

Remaining unmarked routes on `/tasks` — delete, checklists, dependencies —
stay JWT-only, refused with `403` for a valid key rather than granted. This is
not a claim that every write an agent needs is now open; see
`universal-program/cards/MUN-0046-*.md` for the full route sweep this card
produced and which of those routes are `not_measured` for agent intent.

## Reading activity with the agent key (MUN-0047)

MUN-0046 opened `POST /tasks/:taskId/comments` but no route an agent key could
reach ever read that content back: `GET /tasks/:taskId/activity` was unmarked
(`403`), and there is no separate `GET /tasks/:taskId/comments` route at all —
an agent could write a record neither it nor any other agent could ever read.
`getActivity` now accepts an agent key too, **scoped to the agent's own
assignment** — the identical `'task'` scope (and the identical
`assertAssignedToTask` check) `POST .../comments` already uses, since reading
a task's history is bounded by the same assignment as acting on it:

| route | an agent key gets |
|---|---|
| `GET /tasks/:taskId/activity` | the task's `ActivityLog` entries, if the agent is assigned to the task — otherwise `403` |

`ActivityService.findForTask` returns the full stored row, so a `comment`
action's response includes `payload.body` verbatim — the same content
`POST .../comments` accepted. **This is why no dedicated `GET
.../comments` route was added**: the activity stream already carries comment
bodies in full, unfiltered, and a second route returning the same rows in a
different shape would be duplication to maintain, not a new capability.
Because reading and posting share one scope check, there is no separate
"read-only" abuse case here distinct from the negative control: an unassigned
agent (same workspace) and an agent from another workspace both get the same
`403` an unassigned agent already gets on `POST .../comments`.

## Reading a project's task index with a read grant (MUN-0052)

Inside its workspace an agent key sees its own slice of a project — the tasks it
is assigned to or created. A board registered by a human is therefore invisible
to the agent that has to reconcile it: measured on 2026-09-14, the program
fleet's key listed 416 rows of project `aup` and 471 of its 477 registered tasks
were not among them.

The own slice is **not** widened for every key of the workspace (program decision
DEC-AUP-0029). A key named for a project in `src/auth/project-read-grants.ts`,
with `until` still ahead, may read that project's task **index**:

| route | an agent key gets |
|---|---|
| `GET /tasks/project/:projectId/index` | with a live grant for that project: `{projectId, counted, total, generatedAt, auditEventId, auditReadCount, grant, tasks}`, one row per task of the project (all statuses) with `id, parentId, status, priority, actorType, createdAt, updatedAt, titleSha256`; without one — no grant, expired, another project, another workspace, unknown or malformed id — `404`, the answer an unknown project gets. A JWT gets `403`. |

- No free text: the title leaves as a sha256, the description, bootstrap stamp,
  creator id and revision do not leave at all.
- Every read writes one `activity_log` row (`project:index_read`, payload
  `{projectId, decision, rowCount}`) and returns its id as `auditEventId`, with
  `auditReadCount` — this agent's index reads on record in the workspace, this
  one included — read back from the same table.
- The grant opens this one route. `GET /tasks/:taskId`, activity, comments,
  status, redactions, assign, checklists, dependencies and the project list and
  staleness routes answer a granted key exactly as they answer any other key.
- A grant is a reviewed code change naming its decision, and it lapses at `until`
  by itself.

The rest of `/tasks` stays JWT-only. It is an **allowlist**: a route with
no `@AgentScope(...)` marker refuses an API key by default, so a route added
later is closed the day it merges rather than open until somebody remembers to
close it. The only visible change on those routes is `403` (valid key, out of
scope) instead of `401` (no credential at all).

Two refusals are deliberately indistinguishable from each other:

- a task that does not exist and a task the agent is not assigned to both answer
  `403`, so a key cannot enumerate which task ids are real;
- a project in another workspace answers `404`, the same answer an id that never
  existed gets.

The state machine, the activity log and the actor are unchanged. A move made
with an agent key is recorded with `actor_type = 'agent'` and the agent's id — it
is attributed to the agent, not to a human, and it obeys the same transitions
everyone else does.

## Revoking the key you hold (MUN-0053)

`POST /agents/keys/self/revoke` with `Authorization: Bearer mun_sk_…` revokes
**the key that authenticates the request** and nothing else — the route takes no
id. It answers `200 {keyId, agentId, revokedAt}` and writes one activity row
`agent:api_key_self_revoked` (payload `{keyId}`) in the same transaction. From
then on that key answers `401` everywhere, this route included; the agent's other
keys are untouched. A JWT gets `401`: users revoke keys with
`DELETE /agents/keys/:keyId`.

Use it when a key may have leaked and nobody holding a user credential is at hand.
