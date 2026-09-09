-- MUN-0040 (AUP-DAT-002 / AUP-DAT-003): minimal canonical migration-import surface.
--
-- Purpose: give the Arcanada Universal Program a Muneral-native import path that
-- keeps identity, provenance and historical time separable, and that can be
-- resumed and read back. The pre-existing POST /sync/datarim/:projectId/import
-- collapses all four into "created/updated counts" and stays as a legacy path.
--
-- Additive only. Nothing is dropped, renamed or re-typed; every column added to
-- `tasks` is nullable or carries a default, so existing writers are unaffected.
--
-- Four concerns, four tables, deliberately not collapsed:
--   * migration_batches   — the idempotent unit of work and its commit receipt.
--   * legacy_identities   — the LOGICAL task behind one (namespace, legacy id).
--                           UNIQUE(source_namespace, legacy_id) is the whole
--                           point of AUP-DAT-002: `ARAS-0001` from a nested
--                           tracker and `ARAS-0001` of the root workspace are
--                           two rows, never one.
--   * source_occurrences  — one SOURCE RECEIPT per sighting. Two concurrent
--                           imports of one identity produce one identity row and
--                           two occurrence rows.
--   * identity_mappings   — the reversible same/split/merge/candidate_conflict
--                           record. A proposal is stored, never auto-applied.
--
-- Nothing here dedups by title or embedding: there is no title column outside
-- `tasks` and no similarity index. A title change therefore cannot, on its own,
-- create or merge an identity — only an explicit decision row can.

-- ---------------------------------------------------------------------------
-- migration_batches — idempotent unit of work + commit receipt
-- ---------------------------------------------------------------------------
CREATE TABLE public.migration_batches (
    id UUID NOT NULL DEFAULT uuid_generate_v4(),
    batch_key VARCHAR(200) NOT NULL,
    source_set_epoch VARCHAR(120) NOT NULL,
    producer VARCHAR(200) NOT NULL,
    project_id UUID NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'open',
    request_digest VARCHAR(64) NOT NULL,
    receipt JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    committed_at TIMESTAMPTZ,

    CONSTRAINT migration_batches_pkey PRIMARY KEY (id),
    CONSTRAINT migration_batches_batch_key_unique UNIQUE (batch_key),
    CONSTRAINT migration_batches_status_check CHECK (status IN ('open', 'committed', 'failed')),
    CONSTRAINT migration_batches_request_digest_check CHECK (request_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT migration_batches_committed_check CHECK (
        (status = 'committed') = (committed_at IS NOT NULL AND receipt IS NOT NULL)
    ),
    CONSTRAINT migration_batches_project_fkey FOREIGN KEY (project_id)
        REFERENCES public.projects(id) ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX idx_migration_batches_project_id ON public.migration_batches(project_id);
CREATE INDEX idx_migration_batches_status ON public.migration_batches(status);

-- ---------------------------------------------------------------------------
-- legacy_identities — the logical task behind (source_namespace, legacy_id)
-- ---------------------------------------------------------------------------
CREATE TABLE public.legacy_identities (
    id UUID NOT NULL DEFAULT uuid_generate_v4(),
    source_namespace VARCHAR(300) NOT NULL,
    legacy_id VARCHAR(200) NOT NULL,
    -- Nullable until the identity is bound to a Muneral WorkItem. An identity
    -- can legitimately exist unbound (a candidate_conflict proposal awaiting a
    -- human decision).
    task_id UUID,
    mapping_kind VARCHAR(24) NOT NULL DEFAULT 'same',
    -- Optimistic revision for the mapping. Bumped only by an explicit decision.
    mapping_revision INTEGER NOT NULL DEFAULT 0,
    decided_by VARCHAR(200),
    decided_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT legacy_identities_pkey PRIMARY KEY (id),
    CONSTRAINT legacy_identities_namespace_legacy_unique UNIQUE (source_namespace, legacy_id),
    CONSTRAINT legacy_identities_mapping_kind_check
        CHECK (mapping_kind IN ('same', 'split', 'merge', 'candidate_conflict')),
    CONSTRAINT legacy_identities_mapping_revision_check CHECK (mapping_revision >= 0),
    CONSTRAINT legacy_identities_namespace_nonempty_check CHECK (length(btrim(source_namespace)) > 0),
    CONSTRAINT legacy_identities_legacy_id_nonempty_check CHECK (length(btrim(legacy_id)) > 0),
    CONSTRAINT legacy_identities_task_fkey FOREIGN KEY (task_id)
        REFERENCES public.tasks(id) ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- The historical ID stays a SEARCHABLE ALIAS: one legacy_id may appear in many
-- namespaces and the search endpoint must return every one of them.
CREATE INDEX idx_legacy_identities_legacy_id ON public.legacy_identities(legacy_id);
CREATE INDEX idx_legacy_identities_task_id ON public.legacy_identities(task_id);

-- ---------------------------------------------------------------------------
-- source_occurrences — append-only source receipts
-- ---------------------------------------------------------------------------
CREATE TABLE public.source_occurrences (
    id UUID NOT NULL DEFAULT uuid_generate_v4(),
    legacy_identity_id UUID NOT NULL,
    batch_id UUID NOT NULL,
    source_root VARCHAR(500) NOT NULL,
    source_locator VARCHAR(1000) NOT NULL,
    -- Stable key for an anonymous record. MUST NOT be derived from a line
    -- number alone; the CHECK below rejects the bare-line-number shape that
    -- would silently re-key on the next reflow of the source file.
    source_key VARCHAR(300) NOT NULL,
    content_digest VARCHAR(64) NOT NULL,
    captured_at TIMESTAMPTZ NOT NULL,
    -- The raw status verbatim from the source. Deliberately not constrained to
    -- Muneral's status vocabulary: an unmappable historical status must survive
    -- import, not be rewritten into one.
    historical_status VARCHAR(64) NOT NULL,
    historical_asserted_done BOOLEAN NOT NULL DEFAULT false,
    current_verification VARCHAR(32) NOT NULL DEFAULT 'not_revalidated',
    -- The historical time the SOURCE states, when it states one. Never the
    -- import time; that is recorded_at here and tasks.imported_at there.
    historical_at TIMESTAMPTZ,
    raw_excerpt TEXT,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT source_occurrences_pkey PRIMARY KEY (id),
    CONSTRAINT source_occurrences_receipt_unique
        UNIQUE (legacy_identity_id, source_locator, content_digest),
    CONSTRAINT source_occurrences_content_digest_check CHECK (content_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT source_occurrences_verification_check
        CHECK (current_verification IN ('not_revalidated', 'revalidated_done', 'revalidated_not_done')),
    CONSTRAINT source_occurrences_excerpt_bound_check
        CHECK (raw_excerpt IS NULL OR octet_length(raw_excerpt) <= 16384),
    CONSTRAINT source_occurrences_source_key_nonempty_check CHECK (length(btrim(source_key)) > 0),
    -- A key derived from a line number alone re-keys the record the next time
    -- the source file reflows, which is the failure AUP-DAT-002 names. The
    -- shapes caught are the bare number and the usual line-number spellings,
    -- case-insensitively. A genuinely stable numeric id from another tracker
    -- (an Asana gid, a Jira internal id) is still importable: qualify it with
    -- its source, e.g. 'asana:1203847362', which is better provenance anyway.
    CONSTRAINT source_occurrences_source_key_not_line_only_check
        CHECK (source_key !~* '^(?:l(?:ine)?[ :#_-]*)?[0-9]+$'),
    CONSTRAINT source_occurrences_identity_fkey FOREIGN KEY (legacy_identity_id)
        REFERENCES public.legacy_identities(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT source_occurrences_batch_fkey FOREIGN KEY (batch_id)
        REFERENCES public.migration_batches(id) ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX idx_source_occurrences_identity ON public.source_occurrences(legacy_identity_id);
CREATE INDEX idx_source_occurrences_batch ON public.source_occurrences(batch_id);
CREATE INDEX idx_source_occurrences_recorded_at ON public.source_occurrences(recorded_at);

-- ---------------------------------------------------------------------------
-- identity_mappings — append-only, reversible same/split/merge/conflict record
-- ---------------------------------------------------------------------------
CREATE TABLE public.identity_mappings (
    id UUID NOT NULL DEFAULT uuid_generate_v4(),
    from_identity_id UUID NOT NULL,
    to_identity_id UUID NOT NULL,
    kind VARCHAR(24) NOT NULL,
    mapping_revision INTEGER NOT NULL,
    basis TEXT NOT NULL,
    decided_by VARCHAR(200) NOT NULL,
    decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT identity_mappings_pkey PRIMARY KEY (id),
    CONSTRAINT identity_mappings_edge_unique
        UNIQUE (from_identity_id, to_identity_id, mapping_revision),
    CONSTRAINT identity_mappings_kind_check
        CHECK (kind IN ('same', 'split', 'merge', 'candidate_conflict')),
    CONSTRAINT identity_mappings_revision_check CHECK (mapping_revision > 0),
    CONSTRAINT identity_mappings_no_self_edge_check CHECK (from_identity_id <> to_identity_id),
    CONSTRAINT identity_mappings_basis_nonempty_check CHECK (length(btrim(basis)) > 0),
    CONSTRAINT identity_mappings_from_fkey FOREIGN KEY (from_identity_id)
        REFERENCES public.legacy_identities(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT identity_mappings_to_fkey FOREIGN KEY (to_identity_id)
        REFERENCES public.legacy_identities(id) ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX idx_identity_mappings_from ON public.identity_mappings(from_identity_id);
CREATE INDEX idx_identity_mappings_to ON public.identity_mappings(to_identity_id);

-- ---------------------------------------------------------------------------
-- migration_idempotency_records — replay store for the import + CAS paths
-- ---------------------------------------------------------------------------
-- Not a parallel task store: it holds only the ALREADY-COMMITTED response of a
-- keyed request so a lost response is answered by replay instead of by a second
-- write. The authoritative work item stays in `tasks`.
CREATE TABLE public.migration_idempotency_records (
    scope VARCHAR(32) NOT NULL,
    idempotency_key VARCHAR(200) NOT NULL,
    request_digest VARCHAR(64) NOT NULL,
    response JSONB NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT migration_idempotency_records_pkey PRIMARY KEY (scope, idempotency_key),
    CONSTRAINT migration_idempotency_records_scope_check
        CHECK (scope IN ('work_item', 'transition')),
    CONSTRAINT migration_idempotency_records_digest_check CHECK (request_digest ~ '^[0-9a-f]{64}$')
);

-- ---------------------------------------------------------------------------
-- tasks — import provenance, bootstrap stamp, optimistic revision
-- ---------------------------------------------------------------------------
-- imported_at is the time the row entered Muneral. It is NOT the historical
-- task date, which lives on source_occurrences.historical_at. Keeping both is
-- the whole of AUP-DAT-003's "the start date of new execution does not replace
-- the historical task date".
ALTER TABLE public.tasks ADD COLUMN imported_at TIMESTAMPTZ;
-- MIG-003: one bounded, versioned bootstrap provenance receipt on the first
-- revision of a WorkItem. Write-once; the trigger below rejects any later write.
ALTER TABLE public.tasks ADD COLUMN bootstrap_stamp JSONB;
-- Optimistic revision for the migration CAS transition path. Existing writers
-- do not touch it, so it stays 0 for every task they create or update.
ALTER TABLE public.tasks ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public.tasks ADD CONSTRAINT tasks_revision_check CHECK (revision >= 0);
-- MIG-003 says "bounded". An unbounded receipt would let one import wedge an
-- arbitrarily large blob into a row that can never be rewritten or removed.
-- Deliberately looser than the service's 8 KiB bound: the service measures
-- compact canonical JSON while `jsonb::text` renders a space after every ':'
-- and ',', so equal numbers would leave a window where the service accepted a
-- stamp and this CHECK rejected it as an untyped 500. This is the backstop for
-- writers that do not go through the service, not the primary bound.
ALTER TABLE public.tasks ADD CONSTRAINT tasks_bootstrap_stamp_bound_check
    CHECK (bootstrap_stamp IS NULL OR octet_length(bootstrap_stamp::text) <= 16384);

CREATE INDEX idx_tasks_imported_at ON public.tasks(imported_at);

-- MIG-003 enforcement at the database, not only in the service: once a
-- bootstrap stamp exists it is an immutable provenance receipt.
CREATE FUNCTION public.tasks_bootstrap_stamp_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
    IF OLD.bootstrap_stamp IS NOT NULL
       AND NEW.bootstrap_stamp IS DISTINCT FROM OLD.bootstrap_stamp THEN
        RAISE EXCEPTION
            'tasks.bootstrap_stamp is write-once: rewrite rejected for task_id=%', OLD.id
            USING ERRCODE = 'MUN00';
    END IF;
    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.tasks_bootstrap_stamp_immutable_guard() FROM PUBLIC;

CREATE TRIGGER tasks_bootstrap_stamp_immutable
BEFORE UPDATE ON public.tasks
FOR EACH ROW EXECUTE FUNCTION public.tasks_bootstrap_stamp_immutable_guard();

-- A commit receipt is likewise write-once: a second commit of the same batch
-- must read back the first receipt, never mint a second one.
CREATE FUNCTION public.migration_batches_receipt_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
    IF OLD.receipt IS NOT NULL AND NEW.receipt IS DISTINCT FROM OLD.receipt THEN
        RAISE EXCEPTION
            'migration_batches.receipt is write-once: rewrite rejected for batch_id=%', OLD.id
            USING ERRCODE = 'MUN00';
    END IF;
    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.migration_batches_receipt_immutable_guard() FROM PUBLIC;

CREATE TRIGGER migration_batches_receipt_immutable
BEFORE UPDATE ON public.migration_batches
FOR EACH ROW EXECUTE FUNCTION public.migration_batches_receipt_immutable_guard();

-- ---------------------------------------------------------------------------
-- Provenance tables are append-only and non-destructible
-- ---------------------------------------------------------------------------
-- "Evidence survives deletion of the local transient spool" (AUP-DAT-003): the
-- spool is a bounded transport buffer, these rows are the durable receipt.
CREATE FUNCTION public.migration_provenance_append_only_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
    RAISE EXCEPTION
        'migration provenance table %.% is append-only: % rejected',
        TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
        USING ERRCODE = 'MUN00';
    RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.migration_provenance_append_only_guard() FROM PUBLIC;

CREATE TRIGGER source_occurrences_append_only
BEFORE UPDATE OR DELETE ON public.source_occurrences
FOR EACH ROW EXECUTE FUNCTION public.migration_provenance_append_only_guard();

CREATE TRIGGER source_occurrences_no_truncate
BEFORE TRUNCATE ON public.source_occurrences
FOR EACH STATEMENT EXECUTE FUNCTION public.muneral_append_only_truncate_guard();

CREATE TRIGGER identity_mappings_append_only
BEFORE UPDATE OR DELETE ON public.identity_mappings
FOR EACH ROW EXECUTE FUNCTION public.migration_provenance_append_only_guard();

CREATE TRIGGER identity_mappings_no_truncate
BEFORE TRUNCATE ON public.identity_mappings
FOR EACH STATEMENT EXECUTE FUNCTION public.muneral_append_only_truncate_guard();

REVOKE TRUNCATE ON public.source_occurrences FROM PUBLIC;
REVOKE TRUNCATE ON public.identity_mappings FROM PUBLIC;
