-- MUN-0021: Forward-only rollback refusal.
-- The outbox, lease, delivery-evidence, quarantine, and inbox schema is
-- additive and the evidence tables are immutable. Once applied, this migration
-- cannot be rolled back. Any attempt to reverse it would weaken the
-- append-only guards, destroy evidence, or leave retained tables without
-- protective triggers and indexes.
--
-- To remove these tables in a disposable test environment, drop the entire
-- database. This rollback will never succeed.

DO $$
BEGIN
  RAISE EXCEPTION
    'MUN-0021 migration is forward-only. '
    'The append-only outbox, delivery-evidence, and quarantine tables cannot '
    'be rolled back. Drop the database to clean up in disposable test environments.';
END;
$$;
