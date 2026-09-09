# Migration import surface

`MUN-0040` — the canonical path for importing historical Datarim task cards into
Muneral as first-class Work Items, implementing program requirements
**AUP-DAT-002** (identity), **AUP-DAT-003** (minimal Muneral path),
**AUP-X01..X05** (import profiles) and **MIG-003** (bootstrap stamp).

The older `POST /sync/datarim/:projectId/import` still works and is unchanged,
but it is **legacy**: it answers with `{created, updated}` counts and matches
tasks by title, so it cannot tell you where a card came from, when it was
actually done, or whether two cards with the same ID are the same work. Use the
endpoints below for anything that has to be audited, resumed, or read back.

All routes below sit behind the global `api/v1` prefix. On the deployed API the
full path is `https://api.muneral.com/api/v1/migration/...`.

---

## The four things this surface keeps separate

The whole design exists to stop these collapsing into each other:

| Concept | Where it lives | What it means |
|---|---|---|
| **Source occurrence** | `source_occurrences` | One *sighting* of a record in one source. Append-only. Many per identity. |
| **Logical task (identity)** | `legacy_identities` | The thing the sightings are *about*, keyed by `(source_namespace, legacy_id)`. |
| **Task revision** | `tasks.revision` | Optimistic version of the Work Item, moved only by an explicit CAS transition. |
| **Artifact reference** | `evidenceRefs` on the transition's activity entry | Pointers to evidence held elsewhere; never inlined content. |

Two consequences worth stating plainly:

- **`ARAS-0001` in a nested tracker is not `ARAS-0001` in the root workspace.**
  `UNIQUE (source_namespace, legacy_id)` makes them two identities. The bare
  `legacy_id` stays indexed as a *searchable alias*, so you can still find both
  from the historical ID alone — you just get two answers, not one merged one.
- **Import time is not historical time.** `tasks.imported_at` is when the row
  entered Muneral; `source_occurrences.historical_at` is the date the source
  itself stated. Neither overwrites the other.

### Status projection

The projection from a source's own status onto a Muneral status is a **versioned
artefact**, not an implicit default (AUP-DAT-006, review X-08). The artefacts are
`HistoricalStatusMap/v1` files, vendored byte-identically from the program
contract as `apps/api/src/migration/status-map/status-map-v1-rev<N>.json`, and
**every vendored revision** is validated at boot: a map with a foreign schema, a
non-integer revision, a projection target outside Muneral's `TaskStatus` values,
a completion assertion on a card that projects onto neither `done` nor
`archived`, or two artefacts claiming one revision is a **startup failure**,
never a silent fallback.

Revisions are **kept, not replaced** (MUN-0043). The build ships revisions 2 and
3; the current revision is the highest one vendored, derived rather than written
down. `POST /migration/work-items` takes an optional `statusMapRevision` to
project under an older revision — that is how an occurrence written under
revision 2 is replayed to the value it actually recorded. A revision this build
does not carry is a typed `UNKNOWN_STATUS_MAP_REVISION` (400) listing the ones it
does; it never falls back onto the current map, because that would file a
projection under a rule that did not produce it.

Three facts are kept apart, and all three are readable:

| fact | where it lives |
|---|---|
| what the source said | `source_occurrences.historical_status` — verbatim, never rewritten |
| what Muneral shows | `tasks.status` — the projection |
| what produced the projection | `source_occurrences.status_map_revision` |

An old `done` is an assertion about the past, not a verdict about now. **Which**
raw values assert completion is the contract's decision, not the code's.

#### The map at revision 3 (current)

Lookup is on the raw value **normalised** — NFC, then trim, then a
locale-independent casefold. `Done ` and `  DONE  ` both find `done`; the raw
string stored on the occurrence is still `Done ` and `  DONE  `.

| raw status | `tasks.status` | `historical_asserted_done` | note |
|---|---|---|---|
| `todo` | `todo` | `false` | |
| `pending` | `todo` | `false` | Datarim backlog default |
| `open` | `todo` | `false` | |
| `planned` | `todo` | `false` | |
| `backlog` | `todo` | `false` | |
| `not_started` | `todo` | `false` | |
| `absent` | `todo` | `false` | the source carries no status field — a parser marker, not a source value |
| `unknown` | `todo` | `false` | literal `unknown` in a source |
| `in_progress` | `in_progress` | `false` | |
| `prd_done` | `in_progress` | `false` | PRD accepted, implementation not started — a stage marker, not completion |
| `active` | `in_progress` | `false` | observed once |
| `review` | `review` | `false` | |
| `blocked` | `blocked` | `false` | |
| `paused` | `blocked` | `false` | paused by decision; the raw value carries the distinction |
| `deferred` | `blocked` | `false` | deferred by decision; see `paused` |
| `done` | `done` | **`true`** | |
| `archived` | `archived` | **`true`** | the archive card says the card LEFT THE BOARD — terminal and unverified. Revision 2 projected this onto `done`; revision 3 does not (DEC-AUP-0014 rule 3). The source's completion assertion is still recorded, in the column beside it |
| `done_pending_archive` | `done` | **`true`** | done, archive card not yet written |
| `completed` | `done` | **`true`** | synonym of `done` in older rows |
| `cancelled` | `cancelled` | `false` | |
| `withdrawn` | `cancelled` | `false` | |
| `superseded` | `cancelled` | `false` | an identity decision (merge/split) is required before import closes the card (AUP-DAT-002) |
| `absorbed` | `cancelled` | `false` | absorbed into another task — identity decision required, see `superseded` |

`current_verification` is `not_revalidated` for **every** row, including the four
that assert completion. This path never re-verifies anything (I14).

`archived` is where the two facts come apart, and that is the point.
`historical_asserted_done` records what the SOURCE claimed when it filed the
archive card; `tasks.status` records what Muneral is willing to show. Revision 2
collapsed them, so 1,340 filing decisions read as finished, verified work.
Revision 3 keeps the assertion and refuses the projection.

#### Revision 2 (retained for replay)

Revision 2 is identical to revision 3 except for one row — `archived` → `done`
— and is still vendored and still loadable. The MUN-0041 import wrote 2,726
occurrences under it, every one stamped `status_map_revision = 2`. They are
**not backfilled**: revision 3 did not produce them. Ask for revision 2
explicitly to reproduce what they recorded.

#### UNMAPPED

A raw value whose normalised form is absent from the map is **UNMAPPED**. Two
components treat it differently, on purpose:

- **producer0** (this surface) projects it to `todo`, sets
  `source_occurrences.unmapped = true`, records the map revision that failed to
  recognise it, and keeps the raw string verbatim. It **never rejects a single
  item** — a refusal here would lose the card, and the card is the evidence.
  A `CHECK` makes it impossible for an unmapped occurrence to assert completion.
- **A BULK importer** must treat UNMAPPED as a **typed refusal** (DAT-006) and
  stop, until the value is added to the map in a new revision. Silent defaulting
  is the failure the map exists to prevent, and a bulk run is precisely where it
  would go unnoticed.

The contract carries its own negative controls: `frobnicated` → UNMAPPED;
`Done ` → normalises to `done` with the raw spelling kept.

#### Revision provenance

Every occurrence records `status_map_revision` — the revision that produced its
projection. Rows imported before this column existed carry `0`, rows from the
MUN-0041 import carry `2`, and rows this build writes carry `3` unless the caller
pinned an older revision. None of them is **ever backfilled**: a revision that
did not produce a row may not be recorded against it, and saying otherwise would
be the falsification the column exists to prevent. The commit receipt
reports `statusMapRevision`, the full `statusMapRevisions` set observed in the
batch, and `unmappedCount`, so an orchestrator can prove "0 unmapped" from the
receipt alone.

### What this surface deliberately cannot do

There is no title column outside `tasks` and no similarity index anywhere in the
new schema. A title or embedding match can therefore only ever *propose* a
review — record it as a `candidate_conflict` decision. Replacing a title does
not create a new task and does not merge one.

---

## Authentication

| | Guard | Accepts |
|---|---|---|
| Writes | `ApiKeyGuard` | `Authorization: Bearer mun_sk_…` |
| Reads | `JwtOrApiKeyGuard` | an agent API key **or** a human access JWT |

Writes are agent-only on purpose: the acting principal is taken from the API key
and recorded on the activity entry, so an importer cannot name its own actor.

---

## Endpoints

### `POST /migration/batches`

Open an idempotent unit of migration work.

```jsonc
{
  "batchKey": "datarim-mac-2026-09-05",   // idempotency key
  "sourceSetEpoch": "2026-09-05T00:00:00Z",
  "producer": "producer0",
  "projectId": "…uuid…"
}
```

| Situation | Status |
|---|---|
| new key | `201` with the batch |
| same key, same payload | `200` with the **same** batch |
| same key, different payload | `409 BATCH_KEY_CONFLICT` |
| unknown project | `404 PROJECT_NOT_FOUND` |

### `GET /migration/batches/:batchId`

Receipt readback. Returns the batch including `receipt` (`null` until commit).

### `POST /migration/batches/:batchId/commit`

Closes the batch and stores a receipt:

```jsonc
{
  "batchKey": "…",
  "sourceSetEpoch": "…",
  "producer": "…",
  "counts": { "occurrences": 2, "identities": 2, "workItems": 2 },
  "statusMapRevision": 2,
  "statusMapRevisions": [2],
  "unmappedCount": 0,
  "occurrenceDigest": "…sha256 hex…"
}
```

`statusMapRevision` / `statusMapRevisions` / `unmappedCount` report what is
stored on this batch's receipts, not what this process happens to have loaded: a
batch that spans a deploy shows every revision it actually contains, and
`statusMapRevision` is the highest of them. `unmappedCount` is the number the
map did not recognise — the number a bulk importer must see as `0`.

`occurrenceDigest` is the SHA-256 of the canonical JSON of the batch's
`(source_locator, content_digest)` pairs **sorted**, so two importers that
recorded the same receipts agree on the digest regardless of insertion order.
Committing twice returns the first receipt verbatim — the receipt is write-once
at the database, not merely by convention.

### `POST /migration/work-items`

Import one historical card.

```jsonc
{
  "batchId": "…uuid…",
  "sourceNamespace": "datarim/nested/tracker",
  "legacyId": "ARAS-0001",
  "title": "Historical card",
  "description": "optional",
  "priority": "medium",                    // optional
  "historicalStatus": "done",              // raw, from the source
  "occurrence": {
    "sourceRoot": "datarim/nested/tracker",
    "sourceLocator": "tasks.md#ARAS-0001",
    "sourceKey": "heading:ARAS-0001",      // must NOT be a bare line number
    "contentDigest": "…sha256 hex…",
    "capturedAt": "2026-09-05T08:00:00Z",
    "historicalAt": "2019-04-02T10:15:00Z", // optional; the source's own date
    "rawExcerpt": "…≤ 16 KiB…"              // optional
  },
  "bootstrapStamp": { "…": "…" },           // optional, write-once (MIG-003)
  "idempotencyKey": "import-ARAS-0001-1"
}
```

Behaviour:

- Creates or reuses the `LegacyIdentity` for `(sourceNamespace, legacyId)`.
- Creates the Work Item **once** and sets `imported_at`.
- Records the `SourceOccurrence`, stamped with `status_map_revision` and
  `unmapped` — see [Status projection](#status-projection). The response carries
  `statusMapping: { historicalStatus, taskStatus, unmapped,
  historicalAssertedDone, statusMapRevision }`.
- **Concurrency:** N parallel requests for one identity yield **one** identity,
  **one** task and **N** occurrences. The serialization point is a
  `SELECT … FOR UPDATE` on the identity row inside the transaction.
- Same `idempotencyKey` + same payload → `200` replaying the original response
  byte-for-byte. Same key + different payload → `409 IDEMPOTENCY_KEY_CONFLICT`.
  The key is claimed *inside* the write's own transaction with
  `INSERT ... ON CONFLICT DO NOTHING`, so N concurrent deliveries of one command
  produce one write and N identical answers. (A read-then-write check could not:
  every racer would read "absent" and every racer would write.)
- An identical receipt submitted under a *new* idempotency key collapses onto the
  existing occurrence rather than erroring — same locator and same content is the
  same sighting.
- The batch must still be `open`. A committed batch's receipt is write-once, so
  admitting a late occurrence would leave it permanently understating the batch:
  `409 BATCH_NOT_OPEN`.
- `sourceKey` must not be a bare line number (`417`, `L417`, `line:417`,
  `L-417`, … matched case-insensitively). An anonymous record needs a key that
  survives a reflow of the source file. Rejected by the DTO **and** by a `CHECK`.
  A genuinely stable numeric id from another tracker is still importable —
  qualify it with its source (`asana:1203847362`), which is better provenance
  anyway.
- `capturedAt` and `historicalAt` must carry an explicit UTC offset (a trailing
  `Z` or `±HH:MM`). An offset-less ISO timestamp is valid ISO-8601 but would be
  read in the *server's* local zone, silently shifting the historical date by
  hours depending on where the API happens to run — a rewrite of the one value
  this surface exists to protect.
- `rawExcerpt` is bounded at 16 KiB of **UTF-8 bytes**, not characters: 9 000
  Cyrillic characters are 18 000 bytes, and a character bound would wave exactly
  the content this surface imports into an untyped constraint failure.

**`bootstrapStamp` (MIG-003)** is a bounded, versioned provenance receipt on the
first revision of a Work Item — pinned seed/KC2 ref, digests, IDs, identity
revision, human owner, native authorization refs, time, limits. It is
write-once: offering a second stamp returns `409 BOOTSTRAP_STAMP_IMMUTABLE`,
*including* an identical one, and a `BEFORE UPDATE` trigger rejects any rewrite
whatever the writer. A stamp may still arrive on a later import if the identity
does not have one yet. It is also *bounded*: over 8 KiB of canonical JSON is
`400 BOOTSTRAP_STAMP_INVALID`. The `CHECK` constraint is deliberately looser
(16 KiB) — it counts `jsonb::text`, which PostgreSQL renders with a space after
every `:` and `,`, so equal numbers would leave a window where the service
accepted a stamp and the database rejected it as an untyped 500. The typed 400
always wins; the CHECK is the backstop for writers that bypass the service.

### `GET /migration/work-items/by-legacy/:sourceNamespace/:legacyId`

Full readback — identity, work item, current `revision`, `bootstrapStamp`, and
the occurrences oldest-first. **This is the answer to a lost response:** create,
lose the reply, read back, and you get the same thing. `404 WORK_ITEM_NOT_FOUND`
when absent. Both path segments may be percent-encoded.

Every occurrence in the response carries `historicalStatus` (the source's own
string), `historicalAssertedDone`, `currentVerification`, `statusMapRevision`
and `unmapped` — so the projection can be audited from the readback alone,
without consulting the map that produced it.

### `GET /migration/work-items/search?legacyId=ARAS-0001`

Every identity carrying that historical ID, across all namespaces, with an
occurrence count each. The point is that they come back as *separate* rows.

### `POST /migration/work-items/:taskId/transitions`

The single compare-and-set path.

```jsonc
{
  "expectedRevision": 0,
  "toStatus": "in_progress",
  "idempotencyKey": "move-1",
  "evidenceRefs": ["artifact://plan/mun-0040"],   // optional
  "basis": "migration re-execution begins"
}
```

- The CAS covers the **observed state**, not just the counter: `tasks.revision`
  is bumped by this path alone, so an ordinary `PATCH /tasks/:id/status` moves
  the status while leaving the revision untouched. A revision-only guard would
  let a migration transition silently overwrite an operator's decision — and
  even take a move the state machine forbids. `409 STALE_REVISION` therefore
  carries both `currentRevision` and `currentStatus`; nothing is written.
- The whole operation — claiming the key, the CAS, the audit entry, the stored
  response — is one transaction. Split apart, a crash after the CAS would leave
  a work item whose revision moved, whose audit entry is missing, and whose key
  was never recorded, so every retry would fail `STALE_REVISION` forever.
- Legality is deferred to the shared `TASK_TRANSITIONS` table in
  `@muneral/types` — an illegal move is `400 INVALID_STATUS_TRANSITION`.
- Success bumps `revision` by one and writes an `activity_log` entry with
  `actor_type: agent`, `action: migration.transition`, carrying `basis` and
  `evidenceRefs`.
- Same `idempotencyKey` replays the original result; the revision is bumped
  **once** and one activity entry exists, not two.

> **Why not the execution-authority aggregate?** That aggregate versions the
> *attempt* lifecycle (issued → running → succeeded) against a
> `TaskExecutionAttempt` with a retry budget. A migration status move has no
> attempt and no execution: routing it through that aggregate would mint a
> synthetic attempt per imported card, inventing execution history for work
> finished years ago in another tracker. This CAS is therefore one optimistic
> column on `tasks`, not a second state machine — it owns no states and defers
> every legality question to `@muneral/types`.

### `POST /migration/identities/:identityId/decisions`

Record a reversible identity decision.

```jsonc
{
  "kind": "split",            // same | split | merge | candidate_conflict
  "targets": ["…uuid…", "…uuid…"],
  "basis": "The 2019 card covered two independent deliverables.",
  "expectedMappingRevision": 0
}
```

Direction is stored, not inferred:

| `kind` | edges written |
|---|---|
| `split`, `same`, `candidate_conflict` | subject → each target |
| `merge` | each target → subject |

The response is the **full reverse mapping** — `mappings.outgoing` and
`mappings.incoming`, each resolved to the identity on the other end — so the
mapping can be walked from either side. A stale `expectedMappingRevision` is
`409 MAPPING_REVISION_STALE`; an unknown target is `404 IDENTITY_NOT_FOUND` and
leaves the revision untouched. A subject naming itself as a target is
`400 INVALID_IDENTITY_DECISION`. A `candidate_conflict` is a *proposal*: it
moves no task binding.

This endpoint takes no idempotency key — `expectedMappingRevision` is its
concurrency control. If a retried decision returns `MAPPING_REVISION_STALE`, read
`GET /migration/identities/:id/mappings` to see whether the first attempt landed
before deciding again.

### `GET /migration/identities/:identityId/mappings`

The same reverse mapping, read-only.

---

## Error codes

Every failure carries a machine-readable `code` in the response body:
`{ "code": "…", "message": "…", … }`.

| Code | HTTP | Meaning |
|---|---|---|
| `BATCH_KEY_CONFLICT` | 409 | Batch key reused with a different payload. |
| `BATCH_NOT_FOUND` | 404 | No such batch. |
| `BATCH_NOT_OPEN` | 409 | The batch is committed; its receipt is sealed. Open a new one. |
| `BOOTSTRAP_STAMP_IMMUTABLE` | 409 | The Work Item already carries a bootstrap stamp. |
| `BOOTSTRAP_STAMP_INVALID` | 400 | The stamp is not canonical JSON, or exceeds the 8 KiB bound. |
| `IDEMPOTENCY_KEY_CONFLICT` | 409 | Idempotency key reused with a different payload. |
| `IDENTITY_NOT_FOUND` | 404 | No such legacy identity (subject or target). |
| `INVALID_IDENTITY_DECISION` | 400 | The decision names its own subject as a target. |
| `INVALID_STATUS_TRANSITION` | 400 | The shared task state machine forbids the move. |
| `MAPPING_REVISION_STALE` | 409 | Identity moved on; re-read and retry. |
| `PROJECT_NOT_FOUND` | 404 | No such project. |
| `RAW_EXCERPT_TOO_LARGE` | 400 | The excerpt exceeds 16 KiB of UTF-8. |
| `STALE_REVISION` | 409 | Work item moved on; carries `currentRevision` and `currentStatus`. |
| `WORK_ITEM_NOT_FOUND` | 404 | No such work item, by task id or by legacy key. |

---

## Storage

One additive migration, `20260905120000_add_migration_import_surface`:

- `migration_batches` — `UNIQUE(batch_key)`, write-once `receipt`.
- `legacy_identities` — `UNIQUE(source_namespace, legacy_id)`, index on
  `legacy_id`, optimistic `mapping_revision`.
- `source_occurrences` — `UNIQUE(legacy_identity_id, source_locator,
  content_digest)`, append-only, `raw_excerpt` bounded to 16 KiB, `source_key`
  refused when it is only a line number.
- `identity_mappings` — append-only reverse mapping.
- `migration_idempotency_records` — the bounded replay spool. **Not** a parallel
  task DB: it holds only already-committed responses, and deleting it loses no
  evidence (the receipts are in `source_occurrences`).
- `tasks` gains `imported_at`, `bootstrap_stamp` and `revision NOT NULL
  DEFAULT 0`, plus a trigger making `bootstrap_stamp` write-once and a `CHECK`
  bounding it to 16 KiB.

A second additive migration, `20260905190000_add_status_map_provenance`, adds
the status-map provenance (MUN-0041):

- `source_occurrences.status_map_revision INTEGER NOT NULL DEFAULT 0` — the map
  revision that produced the projection. `0` means "written before this column
  existed"; existing rows are not backfilled.
- `source_occurrences.unmapped BOOLEAN NOT NULL DEFAULT false`, with a `CHECK`
  that an unmapped occurrence can never assert completion.

A third additive migration, `20260905210000_add_archived_task_status`, widens
`tasks_status_check` from six values to seven (MUN-0043):

- `archived` becomes a storable task status, so an import that projects an
  archive card onto `archived` writes a row instead of failing on the CHECK.
- No row is touched. The new constraint accepts a strict superset of the old
  one, so rows imported under revision 2 keep the `done` they were projected
  onto and keep `status_map_revision = 2`.
- Its rollback **refuses** while any row holds `archived`, rather than folding
  those rows back into `done` — that rewrite is the totalisation MUN-0043
  removed, and a rollback script is not the place to perform it.

All three migrations are additive only — nothing is dropped, renamed or
re-typed — and the first two rollbacks are deliberately forward-only, because
dropping those tables or columns would destroy the provenance they exist to
keep.

---

## End-to-end example

```bash
API=https://api.muneral.com/api/v1
KEY=$MUNERAL_API_KEY          # mun_sk_…
PROJECT=…project-uuid…

# 1. Open a batch (repeat safely — the key is the unit of idempotency).
BATCH=$(curl -sS -X POST "$API/migration/batches" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"batchKey":"datarim-mac-2026-09-05","sourceSetEpoch":"2026-09-05T00:00:00Z",
       "producer":"producer0","projectId":"'"$PROJECT"'"}' | jq -r .id)

# 2. Import one historical card.
curl -sS -X POST "$API/migration/work-items" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{
    "batchId":"'"$BATCH"'",
    "sourceNamespace":"datarim/nested/tracker",
    "legacyId":"ARAS-0001",
    "title":"Wire the nested tracker export",
    "historicalStatus":"done",
    "occurrence":{
      "sourceRoot":"datarim/nested/tracker",
      "sourceLocator":"tasks.md#ARAS-0001",
      "sourceKey":"heading:ARAS-0001",
      "contentDigest":"'"$(printf 'card body' | sha256sum | cut -d' ' -f1)"'",
      "capturedAt":"2026-09-05T08:00:00Z",
      "historicalAt":"2019-04-02T10:15:00Z"
    },
    "idempotencyKey":"import-ARAS-0001-1"
  }' | jq .

# 3. Lost the response? Read it back — same answer, no second write.
curl -sS "$API/migration/work-items/by-legacy/datarim%2Fnested%2Ftracker/ARAS-0001" \
  -H "Authorization: Bearer $KEY" | jq '{revision, workItem, occurrences}'

# 4. Same historical ID in another namespace is a DIFFERENT identity.
curl -sS "$API/migration/work-items/search?legacyId=ARAS-0001" \
  -H "Authorization: Bearer $KEY" | jq '.identities[] | .sourceNamespace'

# 5. One CAS transition. A wrong expectedRevision is 409 STALE_REVISION.
TASK=$(curl -sS "$API/migration/work-items/by-legacy/datarim%2Fnested%2Ftracker/ARAS-0001" \
  -H "Authorization: Bearer $KEY" | jq -r .workItem.id)
curl -sS -X POST "$API/migration/work-items/$TASK/transitions" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"expectedRevision":0,"toStatus":"in_progress","idempotencyKey":"move-1",
       "basis":"migration re-execution begins",
       "evidenceRefs":["artifact://plan/mun-0040"]}' | jq .

# 6. Close the batch. Committing twice returns the same receipt.
curl -sS -X POST "$API/migration/batches/$BATCH/commit" \
  -H "Authorization: Bearer $KEY" | jq .receipt
```
