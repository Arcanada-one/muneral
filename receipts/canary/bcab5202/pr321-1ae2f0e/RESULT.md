# PR321 exact-subject route sweep

Subject: source commit `1ae2f0e933eec5850c24ec7024551d1abb8c9c26` (the standing digest grant change). The product checkout was clean when the candidate API was built from it with Node 24.22.1, after building the locked `@muneral/types` workspace dependency. PostgreSQL 16 ran on loopback on a private port, as did Redis 8, with synthetic data and credentials. No production endpoint or data was accessed.

Runner: `route-sweep.mjs.txt`. It is stored as `.txt` so that it is a record document; its sha256 equals that of the executed `.mjs`, as `plan.json` records under `runner`. The runner seeds one synthetic owner, the real `arcanada-assistant` and `aup-orchestrator` agent ids and the real workspace id the digest grant names, and one synthetic project. For each of the 51 routes it sends one authenticated loopback request that expects the route's success status, and one unauthenticated control that expects 401 or 403. The run used a fresh database.

Result: 51 routes and 9 code units, 102 HTTP probes. 52 entities verified, 8 failed, 0 not measured.

The change under review is verified on the candidate: `GET /tasks/digest` with the assistant's key answered 200. The response carried `grant: {"decision":"DEC-AUP-0049","until":"9999-12-31T00:00:00Z"}` and no `renewalDueAt`.

The 8 failures are pre-existing main defects. PR242 measured the same failures on 840e3be. They are exempted in `receipts/graph/pr321-main-debt-exemptions-20261027.json`:
- Five workspace-membership routes return 403 to the owner, with anonymous requests getting 401. Cause: `workspace-member.guard.ts:31` reads `req.actor` before `ActorInterceptor` sets it. Fix work item: Muneral e4d18373-1eae-4835-8d85-b33982029eda.
- `DELETE /tasks/:taskId` returns 500 to the owner, with anonymous requests getting 401. Cause: the activity row is written after the task is deleted (P2003). Fix work item: Muneral c23de150-edd9-470e-a45c-7dc8f3241bae.
- The two controller aggregates that contain those routes fail through them.

Cleanup: the API, Redis and PostgreSQL were stopped by verified PID, and no listener remained on their ports.

This result is candidate-local source evidence only. It does not establish production deployment or live consumer behaviour.
