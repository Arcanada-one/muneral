-- MUN-0043 (DEC-AUP-0014 rule 3): `archived` becomes a task status of its own.
--
-- Why the database and not only the code. `tasks_status_check` is the reason
-- an import that projected a card onto `archived` would fail with an untyped
-- constraint violation rather than storing it: the CHECK, not the TypeScript
-- union, is what the row must satisfy. The service is not the only writer.
--
-- What `archived` means, and what it does NOT mean. An archive card in the
-- Datarim sources records that a card LEFT THE BOARD. Revision 2 of the
-- HistoricalStatusMap projected that onto `done`, which reads as "the work was
-- finished" — a claim the archive step never made. `archived` is terminal and
-- unverified: it says where the card went, not that the work was completed and
-- checked. The completion ASSERTION the source did make survives separately on
-- the occurrence (`historical_asserted_done` with `current_verification =
-- 'not_revalidated'`), so nothing is lost by refusing to fold the two together.
--
-- Widening only, and no row is touched. The CHECK is replaced by one that
-- accepts a strict superset of the values it accepted before, so every existing
-- row still satisfies it and no backfill is possible or intended: rows that were
-- imported under revision 2 keep the `done` they were projected onto, and keep
-- `source_occurrences.status_map_revision = 2` saying which artefact decided it.
-- Re-projecting them is a separate, receipted operation, not a side effect of a
-- schema migration.

ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_status_check;

ALTER TABLE public.tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('todo','in_progress','review','blocked','done','cancelled','archived'));

COMMENT ON COLUMN public.tasks.status IS
    'Muneral task status. `archived` (MUN-0043) is terminal and unverified: the card left the board. It is NOT a synonym for `done`; a historical completion assertion lives on source_occurrences.historical_asserted_done.';
