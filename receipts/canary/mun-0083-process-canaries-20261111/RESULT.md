# Process canaries: the 3 NOT_MEASURED code units of MUN-0083

contour=candidate-local. Subject: Muneral `main` at `f3b87b6e19202cffee3b1e73900458dce8125bdd`, tree
`f977794e3532d926da1665b44e06ce6fe0feed4b` (clean worktree, `dirty=false`, see `source-evidence.json`).
This is NOT a production probe and MUST NOT be reported as one. No exemption is written by this record.

## Entities and outcome (CanaryResult/v2, `result.json`)

| Entity | Probe | Outcome |
|--------|-------|---------|
| `code_unit:apps/api/src/ws/kanban.gateway.ts` | `kanban-gateway-nest-socketio-loopback` | verified |
| `code_unit:apps/web/lib/api/client.ts` | `web-api-client-interceptor-vitest` | verified |
| `code_unit:apps/web/e2e/activity-visible-count/run.mjs` | `activity-visible-count-run-mjs-source-tests` | verified |

Each probe is a process run under `/node/bin/node` inside bubblewrap private user/net/pid/ipc/uts namespaces
(`run_sandbox.sh.txt`), source mounted read-only at `/repo`, no network beyond the sandbox's own loopback.
Producer: `harness.py.txt` calls the vendored `process_observation.run`; the plan is `plan.json`.

## What each probe measures, and what it does not

1. `kanban.gateway.ts`: `kanban-gateway.canary.spec.ts.txt` (run by jest from `/spec`, config `jest.canary.config.json`)
   boots a real Nest application with the `IoAdapter`, a real socket.io server on loopback, the real `@nestjs/jwt`
   service and a real `socket.io-client`. Six cases: no token, non-access token and garbage token are disconnected;
   a member joins `project:<id>` and receives `task:moved`; a non-member is refused with `not_project_workspace_member`
   and receives nothing; delivery stops after `leave:project`. LIMITS: `ProjectMembershipService` is a declared stub
   (the real one needs PostgreSQL); the CORS origin option, the production build artefact and a deployed socket gateway
   are not measured. The spec is a new harness written for this canary, it is not a product test.
2. `client.ts`: the repository's own `__tests__/task-detail-no-auth-retry.test.ts` (1 test) drives the real Axios
   instance with a synthetic adapter: a 401 with `skipAuthRefresh` returns after one attempt, no refresh call, no
   sign-out, one session lookup. LIMITS: the request-interceptor token attachment, the refresh-success path and the
   queued-request path are NOT exercised by this probe; `__tests__/web-consumer-live.test.ts` needs a live API and was not run.
3. `run.mjs`: `node --test source.test.mjs` (13 tests) imports the real `run.mjs` and checks its exported driver
   helpers (request allow-list, bounded output, browser path/digest checks, atomic result publication). LIMITS: the
   Chrome-for-Testing browser run, the Vite fixture server and the eight browser scenarios were NOT executed; this
   measures the driver's helper contracts, not the end-to-end browser flow.

## Execution-input attribution

Product files under `/repo` are `product_source`. The harness spec (`/spec/kanban-gateway.canary.spec.ts`) and the jest
config (`/canary/jest.canary.config.json`) live outside the product root and are attributed with the schema's
`system_executable` kind (path plus measured sha256): that is the only external-input kind the schema accepts; they are
canary harness inputs, not system executables. Each manifest is a named set, not a full import closure.

## Negative controls (supplementary, not part of the CanaryResult)

`negative-controls.txt` (verbatim): one-line mutants bound over the product file inside the same sandbox; each
probe command exited 1. Gateway: join gate disabled, 1 of 6 failed. Client: `!originalRequest.skipAuthRefresh`
removed, 1 of 1 failed. run.mjs: GET-only check removed, 2 of 13 failed. The mutants ran the raw commands, not the
plan, so their digests are not part of any CanaryResult.

## Other limits

Escaped descendants are not proven absent (tool wording). The gate's acceptance of a local-candidate result as the
"live contour" for these entities is NOT_MEASURED until graph-admission runs on a PR.
