# How to switch the outbox relay on (and back off) on an instance

The outbox relay (`apps/api/src/outbox/`) is wired into every API process but **does nothing until it
is switched on**. With it off, every task transition still writes `task_outbox_events` +
`outbox_leases`, and those events stay `pending` forever. Switching it on delivers the backlog and every
new event to the `work-outcome-ledger` consumer, which writes one `work_outcome_records` row per outcome
event (`task:completed`, `task:failed`, `task:terminal_failed`, `task:cancelled`).

This page says what switches it, what to measure before and after, what counts as trouble, and how to
switch it back. Every probe is read-only. The numbers in [Rehearsal](#rehearsal-on-a-dev-stand) come
from a dev stand run of `main` (A2-382), not from production.

## 1. What switches it

| Setting | Meaning | Source |
|---|---|---|
| `OUTBOX_RELAY_ENABLED` | On **only** when exactly `true`. `TRUE`, `1`, `yes`, empty or missing all mean off. | `relayEnabled()`, `outbox-relay.worker.ts` |
| `OUTBOX_RELAY_INTERVAL_MS` | Milliseconds between cycles. Default `5000`. Anything below `1000` or not an integer falls back to `5000`. | `relayIntervalMs()`, same file |
| batch size | 10 events per cycle. Not an env setting. | `DEFAULT_BATCH_SIZE`, `outbox.types.ts` |
| lease TTL | 60 s. A lease left by a killed process is re-polled after this. | `DEFAULT_LEASE_TTL_MS`, `outbox.types.ts` |

The value is read **once, at bootstrap**. Changing the variable in a running container does nothing;
the process has to start again with the new environment.

**Where it lives in production.** Not in this repository: `.env.example` says `false`, and
`docker-compose.prod.yml` takes the environment from `env_file: .env`. On the production host the root
deploy broker (`/usr/local/sbin/arcanada-compose-broker`, source
`Arcanada-one/model-connector` `deploy/arcanada-compose-broker.sh`) installs the root-owned file
`/etc/arcanada/deploy-env/muneral.env` as that `.env` on every `sync`. The switch is one line in that
file:

```
OUTBOX_RELAY_ENABLED=true
```

Because that file is the source for every deploy, the setting survives restarts and deploys. A
container created from an env file **without** the line starts with the relay off, which is the
default. `docker restart` keeps the environment the container was created with; only a re-creation
reads the file again.

**How to see which state a process is in.** The bootstrap log line, one of:

```
outbox relay enabled, consumer=work-outcome-ledger, interval=5000ms
outbox relay wired, disabled (OUTBOX_RELAY_ENABLED != "true")
```

(`arcanada-compose-broker muneral logs 200`). The broker's `env-get` cannot read this key: its
allowlist for `muneral` is empty.

## 2. The probe

`apps/api/scripts/outbox-relay-probe.mjs` prints one `OutboxRelayProbe/v1` JSON document from one
`REPEATABLE READ READ ONLY` transaction, in a session opened with `default_transaction_read_only=on`
(`transaction_read_only: "on"` is part of the output). It cannot write.

```
DATABASE_URL=... node apps/api/scripts/outbox-relay-probe.mjs [--since <ISO-8601>] [--fail-on-breach]
```

The production image does not ship `scripts/`, so on the production host pipe it into the running
container, from a checkout of this repository:

```
docker exec -i -w /app/apps/api muneral-muneral-api-1 \
  node --input-type=module - --since 2026-09-26T00:00:00Z --fail-on-breach \
  < apps/api/scripts/outbox-relay-probe.mjs
```

What it reports:

- `lease_status_counts`, `by_event_type` — outbox events per delivery status, total and per type.
- `window` — for events recorded at or after `--since` (all time without it):
  - `terminal_transitions` — `task_execution_transitions` of type `attempt:succeeded|failed|cancelled`,
    the authority's own record of outcome transitions (not the outbox);
  - `outcome_events`, `outcome_events_delivered`, `outcome_events_pending`;
  - `ledger_rows`, `ledger_distinct_events`;
  - `drained` — `outcome_events == ledger_rows == terminal_transitions`.
- `ledger_inbox_rows` — `consumer_inbox` rows of `work-outcome-ledger` (one per delivered event of any
  type; `attempt:*` events are acknowledged with no ledger row).
- `delivery_attempts_by_disposition`, `retrying_events` (leases with `failure_count > 0` not yet
  delivered or quarantined).
- `breaches` — counts that must all be 0, checked over the whole table regardless of `--since`:
  `duplicate_ledger_events`, `ledger_rows_without_delivered_event`,
  `ledger_rows_with_mismatched_event_type`, `ledger_rows_on_non_terminal_transition`,
  `delivered_outcome_events_without_ledger_row`, `delivered_events_without_inbox_row`,
  `quarantined_events`, `ledger_rows_exceed_terminal_transitions`.
- `verdict` — `clean` or `breach`. With `--fail-on-breach` a breach exits 3.

`delivered_events_without_inbox_row` assumes `work-outcome-ledger` is the only consumer, which is true
while `OutboxModule` binds exactly one. Revisit it when a second consumer is added.

## 3. Switching on

1. **Baseline.** Run the probe without `--since`; keep the JSON. Expect `verdict: clean`, everything
   `pending`, `ledger_rows: 0`, and `terminal_transitions == outcome_events` (both are written in the
   same transaction as the transition). If they differ, stop: the backlog itself is inconsistent.
2. Note the time `T_ON` (UTC).
3. Add `OUTBOX_RELAY_ENABLED=true` to the instance's env file and re-create the container (production:
   the broker's `sync <deployed sha>` re-installs `.env`, then `up`).
4. Read the log: the `outbox relay enabled, consumer=work-outcome-ledger` line must be there. If it
   still says `disabled`, the container was not re-created or the value is not exactly `true`.

## 4. What to measure after

| When | Probe | Expected |
|---|---|---|
| every 30 s while draining | no args | `pending` falls by `10 × 30 s / interval` (60 per 30 s at 5000 ms, less any new events); `delivered` rises by the same; `ledger_rows == outcome_events_delivered` at every read |
| drained (backlog `N` events takes about `N / 10` cycles, `N / 2` s at 5000 ms) | no args | `lease_status_counts` has only `delivered` (plus at most one interval of new events); `window.drained: true`; `ledger_inbox_rows` = delivered count; `delivery_attempts_by_disposition` = `{delivered: <same>}`; `retrying_events: 0`; `verdict: clean` |
| after live traffic | `--since T_ON` | every terminal transition after `T_ON` has its one row within one interval: `terminal_transitions == outcome_events == ledger_rows`, `drained: true` |
| log | — | `outbox cycle {"polled":10,…,"quarantined":0,…}` lines while there is work; no `outbox cycle failed` |

Rows appear **only** for outcome transitions: moving a task to `in_progress` or `review` writes
`attempt:*` events, which are delivered and get an inbox row but no ledger row
(`ledger_rows_on_non_terminal_transition` stays 0).

## 5. What counts as trouble

Switch back ([section 6](#6-switching-back)) on any of these:

- the probe exits 3 (any breach). In particular `duplicate_ledger_events > 0` or
  `ledger_rows_exceed_terminal_transitions > 0` means an effect was applied twice;
  `quarantined_events > 0` means an event the relay could not deliver;
- `outbox cycle failed` in the log on three consecutive cycles, or any cycle with `"quarantined"` above 0;
- `pending` does not fall between two probes 30 s apart while the log shows the relay enabled.

Look into, without switching back: `retrying_events > 0` that clears within a lease TTL (60 s) plus two
intervals is a retried delivery, which the relay is built to do. If it does not clear, treat it as
trouble.

## 6. Switching back

1. Remove the line (or set `OUTBOX_RELAY_ENABLED=false`) and re-create the container.
2. The log must say `outbox relay wired, disabled (OUTBOX_RELAY_ENABLED != "true")`.
3. Probe: `delivered`, `ledger_rows` and `ledger_inbox_rows` stay where they were; new events accumulate
   as `pending` again.

What happens to what was already delivered: **nothing**. `work_outcome_records` is append-only (trigger
`work_outcome_records_append_only` rejects `UPDATE` and `DELETE`), and `consumer_inbox` keeps its rows.
A delivery either commits together with its ledger row and inbox row or not at all, so stopping
mid-cycle leaves no half-effect; a lease held by the stopped process expires after 60 s. When the relay
is switched on again it polls only `pending` and expired leases, and the inbox check
(`consumer_id`, `outbox_event_id`) stops a redelivered event from writing a second row.

Do **not** delete rows from `work_outcome_records` or `consumer_inbox` to "undo" a switch-on: the
trigger refuses, and removing inbox rows would let the next delivery apply the effect again. A breach
row stays as evidence; fix the cause in code.

## Rehearsal on a dev stand

A2-382, 2026-09-25: `main` at `0f84cc1` built and run as `node dist/main.js` (no docker) against a
private PostgreSQL 16, default interval (5000 ms). Tasks created and moved only through the running
API's routes (`POST /api/v1/tasks`, `PATCH /api/v1/tasks/:id/status`).

| Phase | Probe | Result |
|---|---|---|
| A. flag unset; 40 tasks to `done`, 3 to `cancelled`, 5 left `in_progress` | baseline, and again 15 s later | `pending: 139` both times; `terminal_transitions 43 = outcome_events 43`; `ledger_rows 0`; clean |
| B. restarted with `true` | every 10 s | delivered 20 → 40 → … → 139, 10 per cycle, 14 cycles, 71 s; ledger 6 → 13 → … → 43, always `= outcome_events_delivered`; drained: ledger 43 = transitions 43, inbox 139, attempts `{delivered: 139}`, clean |
| C. 5 more `done`, 1 `cancelled` while on | `--since` before them | 6 transitions, 6 events, 6 rows, drained within 12 s |
| D. restarted without the variable; 3 more `done` | all / `--since` | log `disabled`; delivered stays 157, ledger stays 49, inbox stays 157; 9 new `pending` (3 outcome); clean |
| D2. restarted with `TRUE` | all | log `disabled`; nothing moved |
| E. restarted with `true` | all / `--since` | the 9 delivered; ledger 49 → 52 = transitions 52; `ledger_distinct_events 52` (no duplicate); clean |

`test/outbox-relay-probe.postgres.spec.ts` repeats A, B and a red control (a duplicate ledger row turns
the probe to `breach`, exit 3) in CI.
