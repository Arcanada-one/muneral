# Project task staleness report

`GET /tasks/project/:projectId/staleness` reports the age of each in-progress task's current running execution attempt. Tasks without a current running attempt remain `not_measured`; this endpoint does not change task state.

The optional `thresholdHours` query parameter must be one positive, finite decimal number of hours. Fractional values are supported. Missing the parameter keeps the 24-hour default. Blank, malformed, repeated, structured, zero, negative, non-finite, or values whose conversion to milliseconds overflows return HTTP 400 before the report is evaluated.

The endpoint retains its existing project, human-membership, and agent task-scope restrictions.
