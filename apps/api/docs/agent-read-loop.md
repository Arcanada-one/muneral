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
If changed: `200 OK` with full task object and new `ETag` header.

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

Everything else on `/tasks` stays JWT-only. It is an **allowlist**: a route with
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
