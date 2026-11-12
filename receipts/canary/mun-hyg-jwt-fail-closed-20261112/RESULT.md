# Process canary: JWT_SECRET fails closed (MUN-HYG, task b5245745-f678-4bbd-94f7-0f0083a53df8)

contour=candidate-local. Subject: candidate commit `b9bf519b8fd2236f447dd8bb1e53fd21519eb5f9`, tree `cf0e1e695be50211c4c6733518ee091595eed739` (clean worktree, `dirty=false`, see
`source-evidence.json`) on base Muneral `main` `ac0a332865a5aa5f27d6c3588ff3180f4f2ef556`. This is NOT a production
probe and MUST NOT be reported as one. No exemption is written by this record.

## Entities and outcome (CanaryResult/v2, `result.json`)

| Entity | Outcome |
|--------|---------|
| `code_unit:apps/api/src/auth/auth.module.ts` | verified |
| `code_unit:apps/api/src/auth/jwt-secret.ts` | verified |
| `code_unit:apps/api/src/auth/strategies/jwt.strategy.ts` | verified |
| `code_unit:apps/api/src/ws/kanban.gateway.ts` | verified |
| `code_unit:apps/api/src/ws/ws.module.ts` | verified |

One probe (`jwt-fail-closed-nest-socketio-loopback`), run under `/node/bin/node` in bubblewrap private
user/net/pid/ipc/uts namespaces (`run_sandbox.sh.txt`), source read-only at `/repo`, no network beyond the sandbox's own
loopback. Producer: `harness.py.txt` calls the vendored `process_observation.run`; plan generator: `gen_plan.py.txt`.

## What it measures (2 spec files, 15 tests, all passed)

1. `jwt-unset.canary.spec.ts.txt`: `JWT_SECRET` is removed BEFORE any product module is imported. `getJwtSecret` throws
   (unset, empty, blank) with a message that names the variable and contains no value and not the old public literal;
   `ws.module.ts` and `auth.module.ts` refuse at import (module construction); `jwt.strategy.ts` refuses at construction;
   `kanban.gateway.ts` disconnects the handshake and never calls `verify`.
2. `jwt-set.canary.spec.ts.txt`: with the repository's own non-public test value set, `getJwtSecret` returns it;
   `auth.module.ts` registers `JwtModule` with it; `jwt.strategy.ts` accepts a token signed with it and rejects one
   signed with another secret; the real `WsModule` + `KanbanGateway` on a real socket.io loopback server with a real
   socket.io-client: no token, wrong-secret token and non-access token are disconnected; a valid token is accepted;
   `join:project` admits a member and delivers events, refuses a non-member (`not_project_workspace_member`) and delivers
   nothing; `leave:project` stops delivery.

LIMITS: `ProjectMembershipService` and `AuthService` are declared stubs (they need PostgreSQL). `@nestjs/throttler` is the
repository's own test double (`apps/api/test/support/throttler-test-double.ts`, same mapping as the repo jest config), so
`auth.module.ts` is measured for its JWT wiring only, not for throttling. The CORS origin option, the production build
artefact, the real passport HTTP guard chain and a deployed socket gateway are not measured.

## Execution-input attribution

Product files under `/repo` are `product_source`. The two specs and the jest config live outside the product root and are
attributed with the schema's `system_executable` kind (path plus measured sha256), the only external-input kind the schema
accepts; they are canary harness inputs. Each manifest is a named set, not a full import closure.

## Negative controls (supplementary, not part of the CanaryResult)

`negative-controls.txt` (verbatim): 7 mutants bound over one product file inside the same sandbox, each run exited 1 and
failed at least one test: the old literal fallback re-added in each of ws.module.ts, auth.module.ts, jwt.strategy.ts,
kanban.gateway.ts (4 mutants); the helper no longer refusing a blank secret (5 failures); a fixed different secret in
ws.module.ts and in kanban.gateway.ts (2 mutants). The mutants ran the raw jest command, not the plan, so their digests are
not part of any CanaryResult.

## Entities NOT measured by this record

- `route:WS join:project` and `route:WS leave:project`: the process canary tool refuses them. Adding either to the probe
  gives, verbatim (`route-attempt.txt`): `['process evidence supports code units, config keys, deployable-unit roots, and
  graph-bound contracts/documents']`. Their handlers (`handleJoinProject`, `handleLeaveProject`) ARE exercised by this probe
  through `kanban.gateway.ts`, but a route entity cannot be bound to a process result. NOT_MEASURED; no exemption.

## Other limits

Escaped descendants are not proven absent (tool wording). Whether the gate accepts a candidate-local result as the "live
contour" for these entities is NOT_MEASURED until graph-admission runs.

## Re-run after merge

Re-measured 2026-11-12 on candidate commit `b9bf519b8fd2236f447dd8bb1e53fd21519eb5f9` and tree `cf0e1e695be50211c4c6733518ee091595eed739`, with base main `df0313b3548ba315c45ebea28b0446fce4dc8c05`. The process probe exited 0; all 5 code-unit entities remain `verified`; both WS route entities remain `NOT_MEASURED` under the preserved refusal in `route-attempt.txt`. The two specs passed 15/15, and the seven sandboxed negative controls all exited 1 (killed), as listed in `negative-controls.txt`. `SHA256SUMS.txt` binds every record file; all record files are mode 100644. No exemption was added.
