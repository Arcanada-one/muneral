# Workspace digest transition counts (MUN-0069)

Read-only transition-sourced counts for a daily digest consumer. Complements
`GET /tasks/digest` (A2-284), which still lists task rows filtered by
`updatedAt`. Prefer this route for **counts**: comment volume and row edits are
excluded; age crossings stay on MUN-0067.

## Supported route

`GET /tasks/digest/transitions`

- **Grant:** same `@AgentScope('workspace-digest')` entry in
  `apps/api/src/auth/workspace-digest-grants.ts` as `GET /tasks/digest`
  (A2-284). No second grant list. Without a live entry:
  `403 DIGEST_GRANT_REQUIRED`. Grants are never inferred from task scope.
- **Window (required):** half-open UTC `sinceInclusive` / `beforeExclusive`
  over `activity_log.createdAt`, capped at 30 days. Invalid window → `400`.
- **Counts:** `task:status_changed` events only (`payload.from` / `payload.to`).
  Malformed transition payloads are skipped, never counted as comments.
- **Items:** paged transition rows with plaintext `title` (PREFIX-NNNN remains
  visible for digest rendering). Same seven-column widening bound as A2-284.
- **Age crossings:** `ageCrossings.included: false` with an explicit pointer to
  `GET /tasks/project/:projectId/active-status-staleness` (MUN-0067).
- **Bodyless histogram (optional):** `includeStatusHistogram=true` attaches
  current task-row status counts. That snapshot is not a transition count and
  is not an age crossing.
- **Collective mailbox visibility** remains outside this route (digest task
  4924c304 scope).

Audit action: `workspace:digest_transitions_read`.

## Offline builder

`apps/api/src/tasks/workspace-digest-transitions.report.ts` →
`buildDigestTransitionsReport(...)` and `resolveDigestTransitionWindow(...)`.
