# Offline status-transition tooling

Author discipline for when agents must call `PATCH /tasks/:id/status` (and when
a comment is not enough): [`docs/how-to/agent-status-transition-discipline.md`](../../docs/how-to/agent-status-transition-discipline.md).

## Required-transition verifier (MUN-0068)

`verify-required-status-transition.mjs` checks one sanitized envelope for a
single required `task:status_changed` event. It does not call Muneral. Use it
from a future merge/close hook or author preflight so comment-only close fails
closed. Exit codes: `0` PASS, `1` FAIL, `3` NOT_MEASURED (incomplete input),
`2` invalid input.

```sh
node scripts/reporting/verify-required-status-transition.mjs scripts/reporting/fixtures/required-transition-pass.json
```

Input shape:

```json
{
  "schemaVersion": 1,
  "required": {
    "taskId": "11111111-1111-4111-8111-111111111111",
    "from": "in_progress",
    "to": "review"
  },
  "completeness": {
    "state": "complete",
    "evidenceId": "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
  },
  "events": []
}
```

`completeness.state: "incomplete"` yields `NOT_MEASURED` (never PASS). Comments
never satisfy the required transition.

## Offline status-transition counts

`status-transition-counts.mjs` reads one caller-supplied, sanitized JSON envelope and writes one scoped JSON report to stdout. It does not call Muneral, open a database, collect activity, or publish a digest. The caller is responsible for supplying the explicit event cohort, UTC interval, and completeness evidence.

## Run

From the repository root with the repository-pinned Node runtime:

```sh
node scripts/reporting/status-transition-counts.mjs sanitized-activity.json
```

The CLI accepts exactly one argument: an input path, or `-` to read the same sanitized JSON envelope from standard input. A local pipeline can pass a generated sanitized envelope without saving it first:

```sh
cat scripts/reporting/fixtures/complete-one-transition.json | node scripts/reporting/status-transition-counts.mjs -
```

Omitting the argument does not prompt or read stdin. Both carriers use the same streaming 20 MiB limit and report validation. The CLI writes a short fixed error code to stderr and exits nonzero for unavailable, oversized, malformed, ambiguous, or out-of-contract input. It never includes a supplied payload, path, comment, title, stream exception, or error detail in the error text.

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

Limits: 20 MiB input, 100,000 event rows, 50,000 cohort task UUIDs, and a window no longer than 3,660 days. The reader accumulates accepted raw bytes in one buffer of at most 20 MiB and accepts chunks with at most 64 KiB of backing storage. It checks each chunk before copying it; the first chunk that exceeds the remaining input budget is rejected, and no later chunk is requested. A file or stdin stream of exactly 20 MiB is permitted; a larger input returns `INPUT_TOO_LARGE`. This is enforced during reading, not by a file-size precheck. No external dependency, live service, or test database is needed.

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
