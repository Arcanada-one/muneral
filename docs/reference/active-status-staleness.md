# Active-status staleness report (MUN-0067)

Read-only report of stale `in_progress` / `review` / `blocked` tasks using
bodyless project-index fields. Distinct from
`GET /tasks/project/:projectId/staleness` (MUN-0040 execution-attempt age).

## Supported route

`GET /tasks/project/:projectId/active-status-staleness`

- **Grant:** same `@AgentScope('project-index')` grant as
  `GET /tasks/project/:projectId/index` (MUN-0052). Without a live grant: `404`
  (same shape as an unknown project). JWT: `403`.
- **Fields:** bodyless only — `id`, `parentId`, `status`, `priority`,
  `actorType`, `createdAt`, `updatedAt`, `titleSha256`, plus derived `ageMs`
  and `bucket`. No title or description plaintext.
- **Age:** `generatedAt − updatedAt`, where `generatedAt` is the audit row
  timestamp of this read.
- **Buckets (defaults):** `softDays=3`, `hardDays=14`. A task is `gtSoft` when
  `ageMs > softDays` (strict), and `gtHard` when `ageMs > hardDays`. `gtHard`
  also increments `gtSoft` so the histogram matches the measured hygiene
  counters (`gt3d` / `gt14d`).
- **Mutation:** `autoPatch: false`. This route never PATCHes task status.
  Safe `todo` returns remain an optional separate follow-up with evidence rules.
- **Threshold query validation:** `softDays` and `hardDays` must each be a
  single positive finite number of days when present; `hardDays` must be
  strictly greater than `softDays`. Blank, malformed, repeated, structured,
  zero, negative, non-finite, or millisecond-overflow values return HTTP 400
  before evaluation (MUN-0065 intent; closed PR261 is not reopened).

Audit action: `project:active_status_staleness_read`.

## Offline query recipe over a project index

Given a stored answer from `GET /tasks/project/:projectId/index`:

1. Keep only tasks whose `status` is `in_progress`, `review`, or `blocked`.
2. For each row, `ageMs = Date.parse(index.generatedAt) - Date.parse(task.updatedAt)`.
3. Classify with the same strict greater-than thresholds as the route.
4. Emit per-status counts `{ n, fresh, gtSoft, gtHard }` and the stale row list
   using only bodyless fields.

Canonical implementation (importable in tests and agents that hold an index
JSON file):

`apps/api/src/tasks/active-status-staleness.report.ts` →
`buildActiveStatusStalenessReport(index, thresholds?)`.
