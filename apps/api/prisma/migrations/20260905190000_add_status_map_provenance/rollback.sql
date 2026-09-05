-- MUN-0041 status-map provenance is forward-only.
-- status_map_revision and unmapped are provenance ON append-only source
-- receipts: they record which versioned artefact produced a projection.
-- Dropping them destroys that record for every row already imported, and there
-- is no way to re-derive it — a later map revision cannot testify about what an
-- earlier one did. Disposable tests must recreate their isolated database
-- instead. This rollback intentionally never succeeds.

DO $$
BEGIN
  RAISE EXCEPTION
    'MUN-0041 status-map provenance is forward-only. '
    'status_map_revision and unmapped record which HistoricalStatusMap revision '
    'produced each projection and cannot be re-derived; recreate the isolated '
    'database to clean up a disposable test environment.';
END;
$$;
