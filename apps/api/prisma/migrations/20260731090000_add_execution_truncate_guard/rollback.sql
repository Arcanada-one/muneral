-- MUN-0020 (QA remediation, finding F1): forward-only rollback refusal.
-- Reversing this migration would remove the statement-level TRUNCATE guard and
-- restore the exact hole it closes: `TRUNCATE public.task_execution_transitions
-- CASCADE` silently emptying the append-only journal. Like the migration it
-- hardens, it cannot be rolled back.
--
-- To remove these tables in a disposable test environment, drop the entire
-- database. This rollback will never succeed.

DO $$
BEGIN
  RAISE EXCEPTION
    'MUN-0020 migration is forward-only. '
    'The statement-level TRUNCATE guard protecting the journal and attempt '
    'fact tables cannot be rolled back. Drop the database to clean up in '
    'disposable test environments.';
END;
$$;
