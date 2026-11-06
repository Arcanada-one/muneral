# HEAD remeasure — main debt 8 FAILs cleared (e2e)

Subject: `origin/main` HEAD `6d786dca224c4dfcf13ca14693a032c9ab53343f` (tree `9099b9c6bbd77fb36acaae7cdeaad3abc21d0fb7`), worktree `/home/dev/aup/mun-main-debt-8fails-staff`.
Card: Muneral `85190709-51ce-437d-9740-0096389dbb2c`.
Fix lineage: PR #322 merge `a825c58` (ancestor of HEAD). Supersedes closed PR #246.

## Method
Isolated Nest e2e against disposable PostgreSQL 16 container (`sudo -n docker`), suite filter:
`test/human-task-read-isolation.e2e.spec.ts` `-t 'Workspace member routes and task delete'`.
Harness: `apps/api/scripts/run-jest-isolated.mjs` with `NODE_OPTIONS=--experimental-vm-modules`.
No production DB/Redis. Container cleaned up by the suite (name prefix `muneral-workspace-members-task-delete-test-`).

## Result
- Test Suites: 1 passed
- Debt describe: **20 passed**, 0 failed (78 unrelated tests skipped by `-t`)
- Covers the six named routes' owner success + non-member 403 + agent 403 + anonymous 401, plus DELETE audit-before-delete (204) and execution-history 409.

## Mapping to the 8 debt entities
| Entity | Evidence |
|--------|----------|
| route:GET /workspaces/:workspaceId | owner 200; non-member/agent 403; anon 401 |
| route:GET /workspaces/:workspaceId/members | same |
| route:POST /workspaces/:workspaceId/members/:userId | owner 201 path; refusals as above |
| route:PATCH .../members/:userId/role | owner 200 path; refusals as above |
| route:DELETE .../members/:userId | owner 204 path; refusals as above |
| route:DELETE /tasks/:taskId | owner 204 + detached audit; 409 with execution history |
| code_unit:workspaces.controller.ts | derived — member routes verified |
| code_unit:tasks.controller.ts | derived — DELETE verified |

Prior candidate canary on fix subject `3402fde` remains in `receipts/canary/e4d18373/mun-defects-3402fde/` (38 verified / 0 failed).

## Follow-up in this PR
Remove stale live exemptions `receipts/graph/pr321-main-debt-exemptions-20261027.json` (still claimed PREEXISTING_MAIN_FAILURE until 2026-11-10 despite PR #322).

## Limits
This is candidate-local HTTP/PostgreSQL proof of the named defects on current main tip. It is not a full 51-route canary sweep and not a production deploy probe.
