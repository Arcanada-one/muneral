# Workspace Task Digest — `GET /tasks/digest` (A2-284)

An agent key that publishes a daily digest needs one thing Muneral would not
answer: *what moved in my workspace today*. This route answers it, to a key
named in `src/auth/workspace-digest-grants.ts` and to no other.

## What was measured before it existed

Live against `api.muneral.com` on 2026-09-24 with a valid `mun_sk_` key
(A2-281, `runs/A2-281/probe-routes.txt`):

```
GET /api/v1/tasks?limit=2                  -> 403  "This route is not available to an agent API key… (MUN-0043)"
GET /api/v1/tasks/project/<id>             -> 200  []        <- on a board of 880+ tasks
GET /api/v1/tasks/project/<id>/index       -> 404            <- no project-read grant for this key
```

So the assistant's Telegram digest had two possible outputs: `HTTP 403` every
morning, or — had it used the project route — a well-formed, authorised,
completely false *"nothing happened today"*. The second is worse: nothing about
it looks wrong.

`GET /tasks` is unmarked, and an unmarked route refuses an API key by default
(`AgentTaskScopeGuard`, MUN-0043). That default is correct and stays: this
change does not touch it.

## The choice: a route of its own, not a scope on `GET /tasks`

Both were considered. `@AgentScope('workspace-digest')` on `GET /tasks` would
have cost the consumer nothing at all — it already sends exactly that request.
It was rejected anyway, for one reason: `TasksService.query()` has **no
workspace narrowing**, by design, because the JWT route is cross-workspace.
Scoping it would mean a narrowing applied *conditionally*, on a method whose
default is every workspace — one forgotten branch, one refactor, one new caller
away from a cross-tenant list, and nothing in the type system to catch it.

`digestForWorkspace(workspaceId, …)` takes the workspace as a **required
parameter** and ANDs it into the `where` clause itself. There is no argument
list that answers unscoped. The same applies to the columns: the SELECT is an
allowlist of seven, so a column added to `tasks` next year does not reach an
agent key by merging.

**The cost, stated plainly:** the consumer changes its path from
`/api/v1/tasks` to `/api/v1/tasks/digest`. The envelope's first four keys —
`items`, `total`, `limit`, `offset` — and every filter it sends are unchanged,
so that is the whole change (`arcanada-assistant#76`, `MuneralWorkItemsReader`).
Its schemas are `passthrough()`, so the four additive keys below need no edit.

## The shape

```http
GET /tasks/digest?status=done&updatedSince=2026-09-24T00:00:00Z&updatedBefore=2026-09-25T00:00:00Z&limit=200
Authorization: Bearer mun_sk_<key>
```

```json
{
  "items": [
    {
      "id": "…", "projectId": "…", "title": "Ship the digest",
      "status": "done", "priority": "high",
      "createdAt": "2026-09-20T08:00:00.000Z", "updatedAt": "2026-09-24T09:12:00.000Z"
    }
  ],
  "total": 1, "limit": 50, "offset": 0,
  "counted": "every task of the key's own workspace matching the filters, before paging",
  "generatedAt": "2026-09-24T19:40:00.000Z",
  "auditEventId": "…",
  "grant": { "decision": "DEC-AUP-00NN", "until": "…", "renewalDueAt": "…" }
}
```

Filters: `status`, `projectId`, `updatedSince` (inclusive), `updatedBefore`
(exclusive), `limit` (≤ 200, default 50), `offset`. Ordered by `updatedAt`
descending, then `id`. `total` counts before paging, so an empty page and an
empty workspace are different answers.

**There is no `completedAt`.** Measured on this schema: `tasks` carries
`createdAt` and `updatedAt` only. "Completed today" is therefore `status=done`
AND `updatedAt` inside the local day — which over-reports exactly one case, a
task finished earlier whose row was edited today, and under-reports none.

## What it does not return, and why

No `description` (free text no digest prints), no `createdById` / `actorType`
(authorship is the activity log's question), no `bootstrapStamp`, `importedAt`,
`revision`, `contractDigest`, `sprintId`, `parentId`, `dueDate`,
`estimateHours`. No project name either: the measured consumer renders
`projectId` and nothing else, and adding a column is a one-line change with its
own review — which is the right price for widening a read.

## The grant

A marker alone would open the route to **every** key of every workspace the day
it merged. So the guard also requires an entry in
`src/auth/workspace-digest-grants.ts` for (this agent, its workspace):

* the shipped list is **empty**, pinned by a test — merging this change grants
  nothing to anybody;
* the first entry is its own pull request, naming its `decision` and what
  evidence bought it;
* `until` is required and capped at `MAX_GRANT_WINDOW_DAYS` — the same 30 days
  DEC-AUP-0029 set for the *narrower* project index;
* no grant → `403 DIGEST_GRANT_REQUIRED`; an expired one → `403 GRANT_EXPIRED`
  naming `until` and the decision, told apart from never-granted because
  DEC-AUP-0029's first grant lapsed and the read went quiet for two days;
* every successful read carries `grant.renewalDueAt`, seven days before the end,
  so a lapse is visible before it happens;
* every read writes one `workspace:digest_read` activity row — agent, decision,
  row count and the filters asked, never the rows returned — and the answer
  carries that row's id. A read whose audit row cannot be written fails.

### It is wider than the project index, and that is the point

MUN-0052 answers a sha256 of each title *precisely* because titles can carry
secrets. This route returns those titles in the clear, for the whole workspace,
to a granted key. A digest that says "3 задачи завершено" without naming them is
not a digest. What bounds the widening is everything above — per-agent grant,
expiry, own workspace, seven columns, read-only, audited — plus the fact that
the titles go to the operator who would otherwise be reading the board.

Nothing here is consulted by any write. A key holding a digest grant still
cannot move a status, comment, assign, redact or delete a task it does not own,
and still cannot reach `GET /tasks`; that is pinned in
`test/agent-workspace-digest.e2e.spec.ts`.

## Granting it

1. Create the agent and its key in the workspace (`POST /agents`).
2. Open a pull request adding one entry to `WORKSPACE_DIGEST_GRANT_LIST` with
   `agentId`, `agentName`, `workspaceId`, `until` (≤ 30 days out), `decision`
   and `evidence`.
3. The consumer needs no redeploy for the grant itself — but it does need the
   path `/api/v1/tasks/digest`.
