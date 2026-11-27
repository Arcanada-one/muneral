# Execution-attempt staleness report (MUN-0040)

`GET /tasks/project/:projectId/staleness` reports execution-attempt age for
the project's `in_progress` tasks. This is distinct from
[`active-status-staleness`](active-status-staleness.md), which derives age from
task updates and covers additional statuses.

## Request

The route requires the `project` agent scope. An optional `thresholdHours`
query parameter sets the positive, finite threshold in hours; it must appear
once as a scalar. The default is 24 hours. Invalid, repeated, structured, zero,
negative, or overflowing values return HTTP 400.

## Response

The response is an array of entries with `taskId`, `priority`, `verdict`,
`ageMs`, and `reason`. `verdict` is `healthy`, `stalled`, or `not_measured`.
`ageMs` is the elapsed milliseconds from the running attempt's `startedAt`, or
`issuedAt` when `startedAt` is null. It is `null` when no current running
attempt can be measured.

A running attempt is `stalled` only when its age is strictly greater than the
threshold; equality is `healthy`. A missing execution record or a current
attempt that is not running is `not_measured`.

## Reason format

For a running attempt over the threshold, the deterministic reason is:

`running <age>, over the <threshold> threshold`

Durations are rendered from largest to smallest as hours (`h`), minutes (`m`),
seconds (`s`), then milliseconds (`ms`). Whole hours and minutes are emitted
without zero-valued units; the remaining seconds preserve their millisecond
fraction without rounding. A positive remainder below one second is emitted in
milliseconds. A zero duration is `0ms`.

Examples:

- `running 1h, over the 30m threshold`
- `running 1h 30m, over the 1h threshold`
- `running 30m 1s, over the 30m threshold`
- `within threshold` for a measurable attempt at or below the threshold
- `no recorded execution attempt for this task` when no attempt is recorded
