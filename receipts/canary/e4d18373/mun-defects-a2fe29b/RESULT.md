# Member-guard / task-delete exact-subject route sweep

Subject: source commit `a2fe29b1628b5b0782c48227413f5c721870d750` (fix for Muneral e4d18373 and c23de150). The product checkout was clean when the candidate API was built from it with Node 24.22.1. PostgreSQL 16 and Redis 8 ran on loopback on private ports, with a fresh database, synthetic data and synthetic credentials. No production endpoint or data was accessed.

Runner: `route-sweep.mjs.txt`, adapted from the PR #321 runner. It is stored as `.txt` so it is a record document; its sha256 equals that of the executed `.mjs`, as recorded under `runner` in `plan.json`. It differs from the PR #321 copy in two ways. The default port is different. `GET /tasks/digest` expects 403 with code `GRANT_EXPIRED`, because the shipped grant expired on this base at 2026-10-27T00:00:00Z; renewing it is PR #321's change. For each of the 51 routes the runner sends one authenticated loopback request expecting the route's success status, and one unauthenticated control expecting 401 or 403.

Result (after, at the subject): 51 routes and 102 HTTP probes, all as expected. The 38 entities named in `route-sweep.json` are all verified, with 0 failed and 0 not measured. These are exactly the not_measured entities of the code commit's dry-run CAR.

Before (`before-main-source-probes.json`): the same runner was run against a build of the same branch with `workspace-member.guard.ts` and `tasks.service.ts` restored from main `ef09669`. That build was uncommitted and is diagnostic only; it is not a measured subject. It gave 6 failures:
- the 5 workspace-member routes answered 403 "Human authentication required" to the owner;
- `DELETE /tasks/:taskId` answered 500.

All 6 routes are green at the subject.

Scope limits:
- The web client `workspaces.ts` is bound to the two routes it calls with an id-free path (`GET /workspaces`, `POST /workspaces`).
- Its `fetchWorkspaceMembers` calls `/workspaces/<slug>/members` with a slug. That route takes a UUID, so this is a separate, pre-existing web defect. It is not measured here and not fixed by this change.

Cleanup: the API and Redis were stopped by PID, and no listener remained on their ports.

This result is candidate-local source evidence only. It does not establish production deployment or live consumer behaviour.
