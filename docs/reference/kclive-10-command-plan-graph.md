# KCLIVE-10 — Muneral command association and revisioned graph replay

Owner-managed Muneral surfaces for Live Lab Agent Runs. Spec pin:
`documentation/plans/knowledge-collective-live-lab/TASKS.md#kclive-10` @
`68661fb5cb4c6c227037636cfcb9b112f0964555`.

## Rematch

| Surface | Rematch |
| --- | --- |
| Create/status/dependency/execution/outbox | Existing Muneral APIs; do not rebuild |
| Shared run/event/artifact contract | KCLIVE-01 `3dec6172` / arcanada-shared PR #111 head `99f3d83f` (review residual; do not steal) |
| Native dependency enum | `depends_on` / `blocks` / `related_to` / `duplicates` only |
| Migration `Task.revision` | Unchanged — migration CAS only |

## New routes

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/v1/tasks/commands` | Durable idempotent command→root/run association (+ create) |
| `GET` | `/api/v1/tasks/:taskId/plan` | Exact authoritative plan/graph revision readback |
| `PUT` | `/api/v1/tasks/:taskId/plan` | Owner-managed plan revision with CAS (`expectedRevision`) |
| `POST` | `/api/v1/tasks/:taskId/plan/lease` | Bind execution lease to plan revision+digest |
| `POST` | `/api/v1/tasks/:taskId/plan/readiness` | required_for_acceptance readiness (cancelled/archived alone insufficient) |

## Semantics

1. **Idempotency.** Scope = principal + project + operation + key. Same normalized
   command digest → same stored root/run. Different digest → `COMMAND_IDEMPOTENCY_CONFLICT`.
2. **Plan revision.** Stored in `task_plan_revisions` / `task_plan_heads`, not
   `tasks.revision`. Lab projections must not assign this revision.
3. **Acceptance roles.** `required_for_acceptance` may map to `depends_on`/`blocks`.
   `optional` may map to `related_to`/`duplicates` only — never blocking.
4. **WS/outbox scope.** `join:project` requires current workspace membership of the
   project. Logged-in socket alone is refused. Client outbox delivery is filtered by
   current member project ids.
5. **Projection recovery.** Authorized snapshot + watermark only; never replays a
   business command. Live consume of `@arcanada/access-contracts` knowledge-observation-v1
   remains `NOT_MEASURED` until that package is published (KCLIVE-01 residual).

## Feature flag / deploy notes

- Schema migration: `20261106210000_add_command_association_plan_graph`
- Actual outbox relay enablement/delivery: measure with disposable Postgres
  (`test/outbox-relay-probe.postgres.spec.ts` → `scripts/outbox-relay-probe.mjs`).
  That is an empirical relay proof on a task-owned database, not a mock.
- Deployed-host outbox relay enablement: measure with
  `apps/api/scripts/outbox-relay-probe.mjs` against that environment's
  `DATABASE_URL` — record `NOT_MEASURED` when that URL is unavailable to the
  author lane.
- Client outbox delivery call-site: `KanbanService.deliverScopedOutboxEvents`
  filters via `scopeOutboxEventsByMembership` using
  `ProjectMembershipService.listMemberProjectIds`.
