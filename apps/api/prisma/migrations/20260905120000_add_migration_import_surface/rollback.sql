-- MUN-0040 migration-import surface is forward-only.
-- source_occurrences and identity_mappings hold append-only migration
-- provenance: the source receipts and identity decisions that AUP-DAT-002
-- exists to keep. Dropping them would destroy the evidence that is meant to
-- outlive the transient import spool, and dropping tasks.bootstrap_stamp would
-- destroy the MIG-003 bootstrap receipt. Disposable tests must recreate their
-- isolated database instead. This rollback intentionally never succeeds.

DO $$
BEGIN
  RAISE EXCEPTION
    'MUN-0040 migration-import surface is forward-only. '
    'Append-only import provenance and the MIG-003 bootstrap receipt cannot be '
    'rolled back; recreate the isolated database to clean up a disposable test '
    'environment.';
END;
$$;
