# Status-transition counts (MUN-0075)

Project-scoped daily counts of `task:status_changed` activity rows. Distinct
from the offline CLI in `scripts/reporting/status-transition-counts.mjs`
(caller-supplied sanitized envelope) and from gap
`GET /tasks/project/:projectId/transition-report`.

## Supported route

`GET /tasks/project/:projectId/status-transition-counts`

- **Grant:** same `@AgentScope('project-index')` grant as
  `GET /tasks/project/:projectId/index` (MUN-0052). Without a live grant: `404`
  (same shape as an unknown project). JWT: `403`.
- **Window (required):** half-open UTC interval via query parameters
  `startInclusiveUtc` and `endExclusiveUtc` (ISO-8601 ending in `Z`). Missing,
  malformed, inverted, repeated, structured, or oversized windows
  (`> 3660` days) return HTTP 400 before evaluation.
- **Cohort:** every task currently in the project (all statuses). Counts are
  transition *events*, not unique transitioned tasks.
- **Events:** `activity_log.action = task:status_changed` with `taskId` in the
  cohort and `createdAt` in `[start, end)`.
- **Verdicts:** `transitions.verdict = MEASURED` with
  `inputCompleteness.state = DB_COHORT_COMPLETE`. `rates` and `comparability`
  remain `NOT_MEASURED` with reasons (NOT_MEASURED is never PASS).
- **Mutation:** `autoPatch: false`. This route never PATCHes task status and
  never touches key lifecycle routes.

Audit action: `project:status_transition_counts_read`.

## Offline sibling

When only a sanitized activity envelope is available offline, use
`scripts/reporting/status-transition-counts.mjs`. That CLI keeps
caller-reported completeness; it does not replace this live route.
