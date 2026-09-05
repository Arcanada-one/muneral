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

### Historical status

An old `done` is an assertion about the past, not a verdict about now:

| Source status | `tasks.status` | `historical_asserted_done` | `current_verification` |
|---|---|---|---|
| `done` | `done` | `true` | `not_revalidated` |
| any other known status | the same status | `false` | `not_revalidated` |
| anything unrecognised | `todo` | `false` | `not_revalidated` |

An unrecognised status is **never** invented into something plausible — the raw
string survives verbatim on the occurrence, and the response reports
`statusMapping.unmapped: true`.

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
  "occurrenceDigest": "…sha256 hex…"
}
```

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
- Records the `SourceOccurrence`.
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

The migration is additive only — nothing is dropped, renamed or re-typed — and
the rollback is deliberately forward-only, because dropping these tables would
destroy the provenance they exist to keep.

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
