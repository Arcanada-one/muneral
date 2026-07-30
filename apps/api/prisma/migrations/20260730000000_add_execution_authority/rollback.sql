-- MUN-0020: Forward-only rollback refusal.
-- The execution-authority schema is additive and the journal is immutable.
-- Once applied, this migration cannot be rolled back. Any attempt to reverse
-- it would weaken the append-only guard, destroy evidence, or leave retained
-- tables without protective triggers and indexes.
--
-- To remove these tables in a disposable test environment, drop the entire
-- database. This rollback will never succeed.

DO $$
BEGIN
  RAISE EXCEPTION
    'MUN-0020 migration is forward-only. '
    'The append-only journal, execution state, and attempt tables cannot be '
    'rolled back. Drop the database to clean up in disposable test environments.';
END;
$$;
