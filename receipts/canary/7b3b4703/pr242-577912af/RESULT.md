# PR242 candidate-local route canary

**Subject:** PR #242, commit `577912af0aa71cd3b27df69ab3e5c124b74bf39e`, tree `3af0cfb6bb46986bff0f2d0ce2b47678b86b24b1`.

The bounded sweep exercised 51 routes and 7 mapped controller code units using 103 HTTP probes against the candidate-local Nest API, an owned disposable PostgreSQL 16 database, private Redis, and synthetic principals. It produced 50 verified entities, 8 failed entities, and 0 not-measured entities. The route-result JSON contains each request, expected/observed status, response hash, and entity mapping.

The failures are six owner-route failures and two affected code units:

| Entity | Expected | Observed |
|---|---:|---:|
| `route:POST /workspaces/:workspaceId/members/:userId` | 201 | 403 |
| `route:PATCH /workspaces/:workspaceId/members/:userId/role` | 200 | 403 |
| `route:GET /workspaces/:workspaceId` | 200 | 403 |
| `route:GET /workspaces/:workspaceId/members` | 200 | 403 |
| `route:DELETE /workspaces/:workspaceId/members/:userId` | 204 | 403 |
| `route:DELETE /tasks/:taskId` | 204 | 500 (`activity_log_task_id_fkey`) |
| `code_unit:apps/api/src/workspaces/workspaces.controller.ts` | pass | failed through 7 mapped routes |
| `code_unit:apps/api/src/tasks/tasks.controller.ts` | pass | failed through 23 mapped routes |

The membership responses match the known guard/interceptor ordering defect; task deletion matches the known activity-log foreign-key defect. Both fixes are present on the separate PR #246 branch, not in this PR242 subject. The remaining 45 route entities and 5 other code-unit entities were verified by the sweep.

The digest-specific controls passed: the granted synthetic key received HTTP 200 with `grant.until` equal to `2026-10-27T00:00:00Z`; a non-granted key received HTTP 403 with `DIGEST_GRANT_REQUIRED`; anonymous access received HTTP 401. Separate candidate-local digest integration tests passed 30/30 across 2 suites, including granted, expired, absent-grant, and anonymous cases.

**Disposition:** this is a measured but failing candidate-local canary. It does not establish production deployment or restoration, and its 8 failed entities block an admission claim and merge of this exact PR242 source subject. Re-run against the final integrated source head after PR #246 is resolved; do not transfer these results to a changed source head.

## Evidence files

- `route-sweep.json` — full 51-route/7-code-unit request, status, hash, and entity results.
- `plan.json` and `source-evidence.json` — plan and source binding.
- `negative/` — negative plan, result, source binding, and expired/no-grant/anonymous digest test receipt.
- Candidate API test log: 6,240 bytes; stored as content in Muneral task 7b3b4703 alongside its digest-bound receipt.
- Secret scan: gitleaks reported no leaks in this evidence directory; `git diff --check` passed.
