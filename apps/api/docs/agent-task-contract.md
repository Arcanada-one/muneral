# The task-read contract for an agent `mun_sk_` key

What a `/tasks/*` response contains, what it deliberately does not, and which
route answers the question the missing part would have answered.

Written because the omission below was not written down anywhere, and the shape
of the answer does not reveal it.

## The failure this document exists to prevent

An executor holding an agent key read `GET /tasks/:id`, looked for a
dependency field, found none, and applied the ordinary defensive idiom:

```python
deps = task.get("dependencies") or []   # WRONG against this API
if not deps:
    mark_ready(task)
```

`GET /tasks/:id` has never returned a dependency field. `.get()` therefore
returned `None`, `or []` turned that into an empty list, and the executor
reported **254 `todo` tasks ready instead of the handful that were** — including
tasks the same run had measured as blocked an hour earlier.

Nothing malfunctioned. Every call returned `200`. The absence of a field was
read as the presence of an empty one, which is the
"not measured read as pass" failure the program forbids outright: **absence of a
signal must not read as a clean signal.**

## What `GET /tasks/:id` returns

The task **row**, and only the row. Every key below is always present; there
are no conditional keys, so a key you do not see is a key this route does not
serve — not a key that happened to be empty.

```json
{
  "id": "05544b34-6f1e-42cc-924c-186e896e6222",
  "projectId": "08a50f9a-a735-4605-91ce-ce4a41193fbb",
  "sprintId": null,
  "parentId": null,
  "title": "…",
  "description": "…",
  "status": "todo",
  "priority": "high",
  "dueDate": null,
  "estimateHours": null,
  "createdById": "9437639a-5f7c-4fe4-be04-18112ba0bada",
  "actorType": "agent",
  "createdAt": "2026-09-18T09:24:32.763Z",
  "updatedAt": "2026-09-18T09:24:32.763Z",
  "importedAt": null,
  "bootstrapStamp": null,
  "revision": 0
}
```

**Not in this body, and never was:** `dependencies`, `blockedBy`, `ready`,
`checklist`, `comments`, `agents`, `activity`. Dependencies live in a separate
table (`task_dependencies`) and are served by the routes in the next section.

Since MUN-0054 every response from this route — **including a `304`** — carries:

```
X-Muneral-Dependencies: not-in-body; see /tasks/<id>/readiness
```

The header exists so that the absence cannot be read as emptiness in silence.
A consumer that ignores it is no worse off than before; a consumer that reads
it cannot mistake this route's silence for "no dependencies".

The dependency data is not folded into this body on purpose: the body is the
persisted row, and the `ETag` is computed from per-field versions of exactly
those columns. A key in the document that no field version covers would make
the `ETag` a lie about part of its own payload.

## How to find out whether a task is blocked

### `GET /tasks/:taskId/readiness` — use this one

Answers the readiness question server-side, so an executor never infers
readiness from a missing field.

```json
{
  "taskId": "…",
  "dependencyCount": 2,
  "ready": false,
  "blockedBy": [
    {
      "id": "…",
      "type": "depends_on",
      "direction": "outgoing",
      "fromTaskId": "…",
      "toTaskId": "…",
      "otherTaskId": "…",
      "otherTaskTitle": "Migrate the schema",
      "otherTaskStatus": "in_progress"
    }
  ]
}
```

`ready` is a value the server computed, not the emptiness of a list you were
given. Note `dependencyCount`: a task with edges that are all satisfied returns
`ready: true` **and** a non-zero count, so "no edges" and "no unsatisfied edges"
stay distinguishable.

An edge blocks when it is unsatisfied and points the blocking way:

| Edge `type`  | Recorded on   | Blocks this task? |
|--------------|---------------|-------------------|
| `depends_on` | this task     | yes               |
| `blocks`     | the other task, pointing here | yes |
| `related_to` | either        | no                |
| `duplicates` | either        | no                |

An edge is **satisfied** once the counterpart reaches `done`, `cancelled` or
`archived`.

### `GET /tasks/:taskId/dependency-graph`

Every edge touching the task, both directions, with the counterpart's `id`,
`title` and `status`. Use it when you need the edges themselves rather than the
verdict.

### `GET /tasks/:taskId/dependencies` — the legacy shape, read the warning

Returns raw `task_dependencies` rows **filtered on `fromTaskId` only**.

> **This route cannot tell you that a task is blocked.** A `blocks` edge is
> recorded on the *blocker* and names the blocked task in `toTaskId`, so this
> route returns `[]` for precisely the task that is blocked. It is the same
> absent-reads-as-empty trap one layer down. Use `/readiness` unless you
> specifically want the rows recorded *on* this task.

## What an agent key may and may not reach

The default for a `mun_sk_` key is **refusal**. A route is reachable only if it
is explicitly scoped (MUN-0043); an unscoped route answers `403` with:

```
This route is not available to an agent API key.
Authenticate as a user, or ask for the route to be scoped (MUN-0043).
```

**This 403 is an invitation, not a policy ceiling.** MUN-0043 established an
allowlist so that routes added later are not silently reachable — it did not
rule that agent access must stay where it was. MUN-0045, MUN-0046, MUN-0047 and
MUN-0054 each scoped a further route on evidence that an agent needed it. If a
route you need answers this 403, the recorded path is to scope it with a
justification and a negative-control test, not to work around it with a
secondary data source.

| Route | Agent key | Scope |
|---|---|---|
| `GET /tasks/:id` | yes | `task` (assigned) |
| `GET /tasks/:id/readiness` | yes | `task` |
| `GET /tasks/:id/dependency-graph` | yes | `task` |
| `GET /tasks/:id/dependencies` | yes | `task` |
| `GET /tasks/:id/activity` | yes | `task` |
| `POST /tasks/:id/comments` | yes | `task` |
| `PATCH /tasks/:id/status` | yes | `task` |
| `GET /tasks/project/:projectId` | yes, narrowed to own assignments | `project` |
| `POST /tasks` | yes | `project-write` |
| `GET /tasks/:id/field-changes`, `POST /tasks/:id/field-ack` | yes | `task-workspace` |
| `GET /tasks` (filtered query) | **no — 403** | unscoped |
| `DELETE /tasks/:id` | **no — 403** | unscoped |
| `POST`/`DELETE` `/tasks/:id/dependencies` | **no — 403** | unscoped |
| checklist routes | **no — 403** | unscoped |

`403` does not distinguish "not assigned" from "does not exist" — deliberate, so
a key cannot enumerate real task ids. **Do not read a `403` as "no such task"
and do not read it as "empty".**

## Reading the status field

`status` alone is not readiness. A task is `todo` whether or not something
blocks it — `blocked` is a status a human or agent sets explicitly, not one the
dependency graph maintains. In the `aup` project on 2026-09-18 there were 254
`todo` tasks and 5 `blocked` ones; the `todo` count is not a ready count.

Always pair the status with `/readiness`.

## Checklist for a consumer

- [ ] Never `.get("dependencies")` on a `/tasks/:id` body. The key does not exist.
- [ ] Call `/tasks/:id/readiness` and branch on `ready`.
- [ ] Treat a non-`200` as **unknown**, never as ready. A `403` is not an empty list.
- [ ] If a field you expect is absent, check `X-Muneral-Dependencies` and this
      document before assuming the value is empty.
- [ ] Prefer a server-computed verdict over a client-side inference from a
      collection's length.

## History

- **MUN-0043** — agent keys reached `/tasks/*` at all; allowlist scoping introduced.
- **MUN-0045/0046/0047** — task creation, comments, activity read scoped in turn.
- **MUN-0054** — the defect this document records: `/tasks/:id` served no
  dependency field and the only dependency route answered `403` to an agent key,
  so an executor had no authorized way to distinguish "unblocked" from "not
  served". Added `/readiness` and `/dependency-graph`, scoped the existing
  dependency read, added the `X-Muneral-Dependencies` header, and published this
  contract.
