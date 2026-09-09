-- MUN-0041 (AUP-DAT-006, review X-08): record WHICH revision of the versioned
-- HistoricalStatusMap produced an occurrence's projection.
--
-- Purpose. `historical_status` already keeps the source's own string verbatim,
-- and `tasks.status` carries the projection. What was missing is the third
-- fact: the artefact that turned one into the other. Without it, a later
-- revision of the map is indistinguishable from the one actually applied, and
-- "why is this archive card `done`?" has no auditable answer.
--
-- Additive only. Both columns are NOT NULL with a default, so every row written
-- before this migration keeps a truthful value:
--
--   * status_map_revision DEFAULT 0 — revision 0 is not a real map revision
--     (the loader refuses anything below 1). It reads as "projected before this
--     column existed", i.e. by MUN-0040's hard-coded six-status logic, and is
--     deliberately NOT backfilled to 2: those rows were not produced by
--     revision 2 and claiming they were would be the exact falsification this
--     column exists to prevent.
--   * unmapped DEFAULT false — MUN-0040 projected every unrecognised status to
--     `todo` without recording the flag. false is what the pre-existing rows
--     can honestly assert about themselves; the raw string is still there for
--     anyone who wants to re-derive it against a given revision.
--
-- Nothing here is destructive: no column is dropped, no type is narrowed, no
-- existing row is rewritten, and the six TaskStatus values are untouched.

ALTER TABLE public.source_occurrences
    ADD COLUMN status_map_revision INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN unmapped BOOLEAN NOT NULL DEFAULT false;

-- A revision is a non-negative integer: 0 for legacy rows, >= 1 for anything
-- this build writes. A negative value could only come from a corrupted writer.
ALTER TABLE public.source_occurrences
    ADD CONSTRAINT source_occurrences_status_map_revision_check
        CHECK (status_map_revision >= 0);

-- An occurrence the map did not recognise projects onto `todo` and nothing
-- else, and can never assert completion. Enforced at the database because the
-- service is not the only possible writer, and because this is the invariant
-- that keeps a silent default from ever being mistaken for a mapping.
ALTER TABLE public.source_occurrences
    ADD CONSTRAINT source_occurrences_unmapped_not_asserted_done_check
        CHECK (NOT (unmapped AND historical_asserted_done));

COMMENT ON COLUMN public.source_occurrences.status_map_revision IS
    'Revision of the HistoricalStatusMap artefact that produced this projection; 0 = written before MUN-0041, by the hard-coded six-status logic.';
COMMENT ON COLUMN public.source_occurrences.unmapped IS
    'True when the normalised raw status was absent from the map at that revision: projected to todo and flagged, never rejected and never rewritten.';
