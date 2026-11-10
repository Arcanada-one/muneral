# Task/activity snapshot or cursor — G01 Q3 assessment

Muneral work item `350b8ad2-45a4-4fae-82d1-1af3229fdf16` (Agent-Brain mail item (f); related G01 child `d13526a7`).

Pinned source: `Arcanada-one/muneral` @ **59fb3e2696dd9730a6bd29b960a75761bc57a68e** (`main` at assessment authoring). Paths below are under `apps/api/` unless stated.

Status: **assessment and typed contract proposal only**. No HTTP route, schema migration, or runtime writer is added by this document or by the accompanying proposal module. Live database / production paging behaviour is **NOT_MEASURED**.

Prior read-only draft (worker `munsnap01`, pin `97cc45022239bd9bb748b634d332ed3ff4227b7e`) is superseded by this pin. Diff of activity codec/service paths against that pin: **empty** for `src/activity/`, `src/activity-snapshot/`, and `docs/task-activity-snapshot.md`. Line numbers below were remeasured on the new tip.

## 1. Inventory (file:line at the pinned SHA)

### 1.1 Live activity reads

| Read | Route / code | Query, ordering, limits |
|---|---|---|
| Task activity | `GET /tasks/:taskId/activity` — `src/tasks/tasks.controller.ts:564-579`, `@AgentScope('task')`; `page`/`limit` via `parseInt`, defaults `1`/`20` | `ActivityService.findForTask` `src/activity/activity.service.ts:44-62`: `findMany({ where:{ taskId[, task:humanTaskWhere] }, orderBy:{ createdAt:'desc' }, skip, take })` plus a separate `count`, both in one `Promise.all` — **two independent statements, no transaction**. |
| Tie-break | none | `ORDER BY created_at DESC` only. No `id` tie-break. Equal timestamps have unspecified order across pages. No max `limit` clamp seen in the controller (DTO pipe clamp: **NOT_MEASURED**). |
| Workspace activity | `ActivityService.findForWorkspace` `src/activity/activity.service.ts:64-81` | Same shape; same defects. |
| Service bridge | `TasksService.getActivity` `src/tasks/tasks.service.ts:1030-1031` | Thin forward to `findForTask`. |

### 1.2 Codec — `TaskActivitySnapshotCanonical/v1`

- Implementation: `src/activity-snapshot/task-activity-snapshot-canonical.ts`
- Doc: `docs/task-activity-snapshot.md`
- Tests: `test/task-activity-snapshot-canonical.spec.ts`
- Constants `:5-14`: max 10,000 rows, 16 MiB canonical, 64 KiB/activity, 1 MiB/page, 64 MiB page-set, depth 64, 16,384 nodes, page size ≤ 500.
- Build/page/validate: `buildTaskActivitySnapshot` `:171`, `createTaskActivitySnapshotPages` `:251`, `validateAndReconstructTaskActivitySnapshot` `:294`.
- Required source order: `created_at DESC, id DESC` (`:75`, `:205`, `:397-399`). The live read has **no** `id` tie-break, so today's route cannot feed the codec without a new adapter.
- Consumers under `apps/`: **codec + its doc + its spec only**. No Nest module import, no controller route, no persistence (remeasured: `rg` over `apps/api/src` excluding `activity-snapshot/` returns no hits).

### 1.3 Transaction isolation actually used

- Activity reads: **none** (statement-level default; `findMany` and `count` can disagree).
- `RepeatableRead` exists at `tasks.service.ts:881,926` (human dependency reads), `sync.service.ts:102`, `outbox/outbox.relay.ts:551`.
- Writers commonly use `ReadCommitted` with 10 s timeout (`tasks.service.ts:179,662,734`, evidence `:126`, redaction `:162`).
- Postgres `default_transaction_isolation` / pool settings: **NOT_MEASURED** (deployment).

### 1.4 How activity rows are written

- Schema `prisma/schema.prisma:386-405`: `id` = `uuid_generate_v4()` (**random, not monotonic**); `created_at` = `now()` / `CURRENT_TIMESTAMP` (**transaction start time, not commit time**); indexes only on `task_id` and `workspace_id` — no `(task_id, created_at, id)`.
- Sole application writer observed: `ActivityService.log` (`activity.service.ts:33-42`). Append-only is **convention**, not a DB guard. Migration `20260715170000_add_muneral_kb_task_changes` installs `AFTER INSERT OR UPDATE OR DELETE` on `activity_log` (`migration.sql:206-208`), which anticipates UPDATE/DELETE.
- Cascades: workspace delete removes rows; task delete sets `task_id` NULL, so history is no longer reachable by `task_id`.
- Consequence (schema-derived, **not** reproduced): offset paging under concurrent writes can skip or duplicate rows when a late-committing txn inserts a row whose `created_at` sorts into already-delivered pages.

### 1.5 Existing change-detection (option d)

`muneral_kb_task_changes(task_id PK, revision bigint, …)` — migration `20260715170000_add_muneral_kb_task_changes`. Trigger bumps `revision` on task/child changes including `activity_log`. It is a **per-task gap-free committed-change counter** and deleted flag, not a row log. Excellent *validator*; insufficient alone as a pageable activity set.

### 1.6 Access boundary and revocation

- Guard chain: JWT-or-API-key → `@AgentScope('task')` for `/activity` (`tasks.controller.ts:565`).
- `AuthService.validateApiKey` `src/auth/auth.service.ts:230-285`: indexed lookup → bcrypt → `revokedAt === null && (expiresAt null or > now)`. Revocation takes effect on the **next** request (no cache observed in this path).
- Implication: authorization is per HTTP request. Any multi-page cursor must re-authorize every page.

## 2. Options matrix

| | (a) Repeatable-read txn per snapshot | (b) Server snapshot token (max id / epoch) | (c) Per-task append-only sequence + contiguous cursor |
|---|---|---|---|
| Contiguous + complete under concurrent writes | Yes **inside one txn only**. Cannot hold a DB txn across HTTP pages safely. | Only if the bound is commit-ordered. Random UUID `id` and txn-start `created_at` **cannot** bound a stable set. | **Yes**: `seq <= S` is a stable prefix; page by `seq > cursor`; no offset. |
| Cost | Low code for single-response; high risk if held across requests. Fits codec ≤10k rows / 16 MiB in one response. | Medium (token store + expiry); correctness depends on bound source. | Medium: migration, backfill, trigger/in-txn alloc, index; per-task counter hotspot (already present for KB registry). |
| Risk | Long reads delay VACUUM; large bodies; pool pinning if misused for paging. | Gap anomaly if bound ≠ commit order. | Backfill order decision; writer serialization per task. |

**Existing equivalent (d):** `muneral_kb_task_changes.revision` — zero schema cost as validator; not a row set.

Which option yields contiguous complete pages under concurrent writes:

- **(c)** by construction.
- **(a)** only within one response/transaction.
- **(b)** only when built on (c) or a Postgres snapshot; “max activity id” form **fails**.
- **(d)** alone is insufficient; combines with (a) or (c).

## 3. Recommendation (not adopted)

1. **Interim (no schema):** single-response `GET …/activity-snapshot` in one read-only `RepeatableRead` transaction: authorize, read task + `kb_revision`, all rows ordered `created_at DESC, id DESC` (raw SQL text casts), emit `TaskActivitySnapshotCanonical/v1`. Refuse above codec bounds before transfer. `snapshot_id` / digest content-derived.
2. **Durable cursor:** option **(c)** — `activity_log.task_seq` allocated in the writing txn, unique `(task_id, task_seq)`, insert-only guard; cursor = `(snapshot_epoch, high_water_seq, last_seq)` HMAC-signed.

Recommended long-term contract: **(c)**; interim short-history: **(a)+(d)**; **reject (b) in id-bound form**.

## 4. Typed contract proposal (not implemented as a route)

See pure proposal module `src/activity-snapshot/task-activity-snapshot-cursor-proposal.ts` and tests `test/task-activity-snapshot-cursor-proposal.spec.ts`.

Prospective route (owner approval required before any Nest wiring):  
`GET /v1/tasks/{task_id}/activity-snapshot` — idempotent, read-only; `@AgentScope('task')` or a dedicated `task-activity-snapshot` scope for independent revocation.

Request: `cursor?` (opaque ≤ 512 B), `page_size?` 1..500 (default 100), `expected_digest?`.

Response page wraps codec fields plus `consistency`, `high_water`, `next_cursor`, whole-snapshot `digest`.

Errors: `400 PAGE_SIZE_INVALID` / `CURSOR_MALFORMED`, `401/403 NOT_AUTHORIZED` (every page), `404 TASK_NOT_FOUND`, `409 SNAPSHOT_CHANGED`, `410 CURSOR_EXPIRED` / `TASK_DELETED`, `413 SNAPSHOT_TOO_LARGE`, `503 SNAPSHOT_UNAVAILABLE`.

Limits: codec bounds, 15 min expiry, ≤ 10,000 pages, session deadline ≤ 5 min and before expiry.

## 5. Required tests (proposal stubs exercised; live prod NOT_MEASURED)

1. Contiguous pages with duplicate `created_at` and `id` tie-break.
2. Concurrent writes during paging leave the opened snapshot set unchanged (red control: current offset route is expected to fail this — **NOT_MEASURED** against live DB).
3. Stale/expired / forged / cross-task cursor refused.
4. Revoked grant mid-pagination refuses page 2 with no row leak.
5. Deleted-task and oversized-history refusals; digest stable across restart for identical committed data (runtime **NOT_MEASURED**).

## 6. Open questions for Agent-Brain

1. Per-task completeness vs workspace-wide two-producer view?
2. Max accepted history size (if > 10k / 16 MiB, Step 1 alone is insufficient)?
3. Is `SNAPSHOT_CHANGED` retry-from-scratch, or must resume be possible?
4. Bundle dependency-graph/readiness in the same `kb_revision` cut?
5. Backfill policy for `task_seq` on existing rows?
6. Actor classes allowed (agent `'task'` only vs project read grants)?

## 7. Explicit non-claims

No route added. No schema/data mutation. No key-lifecycle probes. Runtime isolation, throughput, DTO limit clamps, and production concurrency remain **NOT_MEASURED**.
