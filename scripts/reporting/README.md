# Offline status-transition counts

`status-transition-counts.mjs` reads one caller-supplied, sanitized JSON envelope and writes one scoped JSON report to stdout. It does not call Muneral, open a database, collect activity, or publish a digest. The caller is responsible for supplying the explicit event cohort, UTC interval, and completeness evidence.

## Run

From the repository root with the repository-pinned Node runtime:

```sh
node scripts/reporting/status-transition-counts.mjs sanitized-activity.json
```

The CLI accepts exactly one input path. It writes a short fixed error code to stderr and exits nonzero for unreadable, oversized, malformed, ambiguous, or out-of-contract input. It never includes a supplied payload, path, comment, title, or error detail in the error text.

## Input contract

```json
{
  "schemaVersion": 1,
  "scope": {
    "taskIds": ["11111111-1111-4111-8111-111111111111"],
    "startInclusiveUtc": "2026-10-27T23:30:00Z",
    "endExclusiveUtc": "2026-10-28T01:00:00Z"
  },
  "completeness": {
    "state": "complete",
    "evidenceId": "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
  },
  "events": [
    {
      "id": "aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
      "taskId": "11111111-1111-4111-8111-111111111111",
      "action": "task:status_changed",
      "createdAt": "2026-10-28T00:10:00Z",
      "from": "todo",
      "to": "in_progress"
    },
    {
      "id": "aaaaaaaa-aaaa-4aaa-8aaa-000000000002",
      "taskId": "11111111-1111-4111-8111-111111111111",
      "action": "task:comment_added",
      "createdAt": "2026-10-28T00:20:00Z"
    }
  ]
}
```

`taskIds` is an explicit array of unique, lowercase canonical UUIDs; an empty array is allowed and means an explicitly empty cohort. The interval timestamps must be strict UTC RFC 3339 values ending in `Z`, with up to millisecond precision, and must satisfy `startInclusiveUtc < endExclusiveUtc`. The end is excluded. Each event requires a unique canonical UUID `id`, canonical UUID `taskId`, bounded machine-token `action`, and strict UTC `createdAt`. A `task:status_changed` event also requires valid `from` and `to` status values from `packages/types/src/index.ts` on the source revision, and they must differ. These fields mirror the event written by `TasksService.updateStatus` (`apps/api/src/tasks/tasks.service.ts`); the report does not inspect `tasks.updatedAt`.

Completeness must be explicitly `complete` or `incomplete` and carry a UUID evidence reference supplied by the caller. This is caller-reported evidence, not independently verified collection completeness. An empty array with `complete` yields a measured zero for the stated event scope. An empty array with `incomplete` yields `NOT_MEASURED`, not a measured zero.

Only `id`, `taskId`, `action`, `createdAt`, and (for a status transition) `from`/`to` are read. Other input fields are ignored and never copied into output. Exact duplicate IDs with identical sanitized identity/value fields count once. If an ID repeats with a different `taskId`, `action`, `createdAt`, `from`, or `to`, the input is ambiguous and fails closed. Comments and all other valid actions are excluded from transition counts. The action/time/task/status values are still validated before filtering.

Limits: 20 MiB input file, 100,000 event rows, 50,000 cohort task UUIDs, and a window no longer than 3,660 days. These keep the offline operation bounded. No external dependency, live service, or test database is needed.

## Output and interpretation

The output echoes the sorted explicit task UUID cohort, exact half-open UTC window, cohort-size denominator meaning, caller-reported completeness and its evidence UUID, total observed transition events, and daily UTC counts. With complete input, it includes zero counts for every date intersecting the window and marks the scoped count `MEASURED`. With incomplete input, the count verdict is `NOT_MEASURED`; it lists only dates where events were observed, and an absent day is explicitly not zero.

Rates are always `NOT_MEASURED`: aggregate events do not establish how many unique tasks transitioned or each task's prior state. Comparability is `NOT_MEASURED` because a single envelope has no paired report proving matching cohort and window. The report makes no global backlog or completion claim. Free-text payloads, comments, titles, actors, and unknown fields do not appear in output.

## Synthetic fixture output

The tracked synthetic input fixture is `scripts/reporting/fixtures/complete-one-transition.json`; run it with the command above. It contains only fabricated UUIDs and sanitized activity fields. The fixture produces a report whose key results are:

```json
{
  "scope": {
    "cohortTaskCount": 1,
    "startInclusiveUtc": "2026-10-27T23:30:00Z",
    "endExclusiveUtc": "2026-10-28T01:00:00Z",
    "timeZone": "UTC",
    "eventAction": "task:status_changed"
  },
  "inputCompleteness": { "state": "CALLER_REPORTED_COMPLETE" },
  "transitions": {
    "verdict": "MEASURED",
    "observedTotal": 1,
    "dailyCounts": [
      { "dateUtc": "2026-10-27", "count": 0 },
      { "dateUtc": "2026-10-28", "count": 1 }
    ]
  },
  "rates": { "verdict": "NOT_MEASURED" },
  "comparability": { "verdict": "NOT_MEASURED" }
}
```

The full output also includes `scope.taskIds`, `scope.denominatorMeaning`, `inputCompleteness.evidenceId`, and the stable explanatory fields described above.
