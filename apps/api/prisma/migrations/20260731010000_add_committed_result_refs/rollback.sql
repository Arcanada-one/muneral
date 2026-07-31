-- MUN-0021 adoption gate: forward-only rollback refusal.
-- The committed-result node and reference relations are append-only records of
-- accepted authority decisions. Reversing this migration would destroy the
-- evidence that a result was committed, or leave retained tables without their
-- protective triggers, uniqueness and restrictive foreign keys.
--
-- Rollback is forward-only: stop accepting new mutations. To remove these
-- tables in a disposable test environment, drop the entire database. This
-- rollback will never succeed.

DO $$
BEGIN
  RAISE EXCEPTION
    'MUN-0021 committed-result migration is forward-only. '
    'The append-only result-node and committed-result-reference tables cannot '
    'be rolled back. Drop the database to clean up in disposable test environments.';
END;
$$;
