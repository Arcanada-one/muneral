# Transition report (MUN-0076)

Project-scoped hygiene report over `task:status_changed` activity rows plus the
current cohort status histogram. Distinct from daily-only
`GET /tasks/project/:projectId/status-transition-counts` (MUN-0075) and from the
offline stdin/file CLI in `scripts/reporting/status-transition-counts.mjs`.

## Supported route

`GET /tasks/project/:projectId/transition-report`

- **Grant:** same `@AgentScope('project-index')` grant as
  `GET /tasks/project/:projectId/index` (MUN-0052). Without a live grant: `404`
  (same shape as an unknown project). JWT: `403`.
- **Window (required):** half-open UTC interval via query parameters
  `startInclusiveUtc` and `endExclusiveUtc` (ISO-8601 ending in `Z`). Missing,
  malformed, inverted, repeated, structured, or oversized windows
  (`> 3660` days) return HTTP 400 before evaluation.
- **Cohort:** every task currently in the project (all statuses).
- **statusCounts:** `MEASURED` histogram of current cohort statuses.
- **Events:** `activity_log.action = task:status_changed` with `taskId` in the
  cohort and `createdAt` in `[start, end)`.
- **transitions:** `MEASURED` with `observedTotal`, UTC `dailyCounts` (zeros
  included), and `edgeCounts` built only from payload `from`/`to` values that
  are distinct valid `TaskStatus` tokens. Malformed payloads still count in
  totals but not in edges.
- **Verdicts:** `rates` and `comparability` remain `NOT_MEASURED` with reasons
  (NOT_MEASURED is never PASS).
- **Mutation:** `autoPatch: false`. This route never PATCHes task status and
  never touches key lifecycle routes.

Audit action: `project:transition_report_read`.
