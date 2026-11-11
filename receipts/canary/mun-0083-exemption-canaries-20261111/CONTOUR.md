# CONTOUR - MUN-0083 exemption canaries

Sidecar to the three produced canary files in this directory. It does not edit them.

## Contour statement

contour=candidate-local

- Subject: Muneral `main` at commit `ae8e201dcc661e27619ed9069b8d30454838e5c4`, tree `05eb00e02bb2682ae0bbcf3e30e45095cb57639c`.
- The resident process was built from that commit in a lane: disposable PostgreSQL 16, API on loopback `127.0.0.1:3511`, Redis absent, placeholder GitHub OAuth config.
- This is NOT a production probe and MUST NOT be reported as one.

## Produced files (not edited)

| File | sha256 |
|------|--------|
| route-plan.json | 10317c5ae7da25f51484c45df34475a2991ef9a3042143176dec415cf26208e6 |
| route-result.json | c897d5b968fdd2a03306e6f7f48b34671f52e81b3363117dbe88d0261693c53c |
| route-result.source-evidence.json | b070578da149ebec89ea6ea723b7f817127a8875aa498ca0df19dfdc023e6273 |

## Why route-plan.json says `"environment": "production"`

Factual cause, read from the repository at the base commit:

- `scripts/canary/gen_plan.py` writes the literal `"environment": "production"` and `"base_url": "http://127.0.0.1:3500"` into every plan it produces (`plan_from_graph`, the returned dict). It has no command-line option for either value (only `--graph` and `--out`).
- `scripts/canary/canary_probe.py` accepts `--base-url` and `--environment` ("override the plan's environment (a local candidate run is not production)"). Its result records `environment or plan["environment"]` and the `base_url` it was given.
- route-result.json records `base_url` `http://127.0.0.1:3511` and an `environment` string that states "local candidate: main ae8e201dcc66 built in lane ... NOT production".

So the `production` value in route-plan.json is the plan generator's fixed default. The RESULT (route-result.json) is the evidence of the contour actually measured.

## Entities not verified (8)

Refused by the canary tools (5), verbatim:

- Refusal text from `process_observation.plan_probe_errors` for each of the five ids: `['process evidence supports code units, config keys, deployable-unit roots, and graph-bound contracts/documents']`
  - `route:WS join:project`
  - `route:WS leave:project`
  - `receipt:receipts/graph/change-admission-mun-artifacts-1f99-08ece05.json`
  - `receipt:receipts/graph/change-admission-mun-artifacts-1f99-8f4d7a5.json`
  - `receipt:receipts/graph/change-admission-mun-artifacts-1f99-d3bf2a2.json`
- `gen_plan.py` `not_measured_by_this_plan`, verbatim: `{"entity": "route:WS join:project", "why": "not an HTTP route: a websocket gateway event is outside the HTTP router this canary reads"}` (same text for `route:WS leave:project`).

NOT_MEASURED (3; no CanaryResult lists them):

- `code_unit:apps/api/src/ws/kanban.gateway.ts`
- `code_unit:apps/web/lib/api/client.ts`
- `code_unit:apps/web/e2e/activity-visible-count/run.mjs`

Count: 102 verified + 5 refused + 3 not measured = 110.

## Finding F1 - two GET probes: status 200 does not describe the candidate

Correction: an earlier author statement "no network use" is WRONG and is withdrawn.

Proven from the files and the probe script at the base commit:

- `route-result.json` probes `route-get-auth-github` and `route-get-auth-github-callback` report status 200 with body sizes 46648 and 46649 bytes. The other protected GET probes report status 401 with 43 or 70 byte bodies.
- `scripts/canary/canary_probe.py` `fetch()` uses `urllib.request.urlopen` with the default opener, which follows HTTP redirects. The recorded `url` of each probe is the candidate URL (`http://127.0.0.1:3511/...`), not a final URL; no redirect chain is stored.
- `apps/api/src/auth/auth.controller.ts` marks both handlers as Passport redirects ("Passport redirects - no body needed").

INFERRED, NOT MEASURED: with a configured GitHub strategy the candidate answers a redirect to an external host, so these two probes most likely left the host and contacted github.com with the PLACEHOLDER client id. The final host is not recorded and was not measured.

Consequence: for these two routes the status 200 and the body are not an observation of the candidate. Their `verified` outcome rests on route-table membership only (`declared_by_resident_route_table: true`). The other 100 probes are not affected by this finding.
