# Member-guard / task-delete exact-subject route sweep

Subject: commit `0b140cf8a585034bfe3a4f61e7be5bf7fd9c1b79`. It is the fix for Muneral e4d18373 and c23de150, merged with main `aae134b`, which includes PR #321, plus a 3072 MB jest heap ceiling in `apps/api/package.json` (test-only).
- The product checkout was clean when the candidate API was built from it with Node 24.22.1.
- PostgreSQL 16 and Redis 8 ran on loopback on private ports, with a fresh database, synthetic data and synthetic credentials.
- No production endpoint or data was accessed.

Runner: `route-sweep.mjs.txt`, adapted from the PR #321 runner.
- It is stored as `.txt` so it is a record document. Its sha256 equals that of the executed `.mjs`, as recorded under `runner` in `plan.json`.
- For each of the 51 routes it sends one authenticated loopback request expecting the route's success status, and one unauthenticated control expecting 401 or 403.
- `GET /tasks/digest` is called with a key of the real `arcanada-assistant` agent id in its real workspace. Since PR #321 that grant is standing, so the probe expects 200 and received it.

Result (after, at the subject): 51 routes and 102 HTTP probes, all as expected. The 38 entities named in `route-sweep.json` are all verified, with 0 failed and 0 not measured. These are exactly the not_measured entities of the dry-run CAR for `aae134b..dc668bd`; the head adds only `apps/api/package.json` and `mutation-results.json`.

Before (`before-main-source-probes.json`): the same runner was run against a build of `dc668bd` with `workspace-member.guard.ts` and `tasks.service.ts` restored from main `aae134b`. That build was uncommitted and is diagnostic only; it is not a measured subject. It gave 6 failures:
- the 5 workspace-member routes answered 403 "Human authentication required" to the owner;
- `DELETE /tasks/:taskId` answered 500.

All 6 routes are green at the subject. This matches the 8 failures PR #321 recorded on `1ae2f0e`: these same 6 routes plus their 2 controller aggregates.

Scope limits:
- The web client `workspaces.ts` is bound to the two routes it calls with an id-free path (`GET /workspaces`, `POST /workspaces`).
- Its `fetchWorkspaceMembers` calls `/workspaces/<slug>/members` with a slug. That route takes a UUID, so this is a separate, pre-existing web defect. It is not measured here and not fixed by this change.

Cleanup: the API and Redis were stopped by PID, and no listener remained on their ports.

This result is candidate-local source evidence only. It does not establish production deployment or live consumer behaviour.
