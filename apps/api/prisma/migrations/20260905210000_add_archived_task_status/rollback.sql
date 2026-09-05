-- Rollback for MUN-0043's archived task status.
--
-- NOT symmetric, and deliberately fail-closed. Narrowing the CHECK back to six
-- values is only safe while no row holds `archived`; PostgreSQL would reject
-- the ALTER anyway, but it would reject it with a constraint-violation message
-- that says nothing about what to do. The explicit count below fails first with
-- a sentence that does.
--
-- Rewriting those rows to `done` is exactly the totalisation MUN-0043 removed,
-- so this script will not do it. Re-project them under revision 2 through the
-- migration surface, with a receipt, and then run this.

DO $$
DECLARE
    archived_rows BIGINT;
BEGIN
    SELECT count(*) INTO archived_rows FROM public.tasks WHERE status = 'archived';
    IF archived_rows > 0 THEN
        RAISE EXCEPTION
            'Refusing to roll back: % task(s) hold status ''archived''. Re-project them explicitly (a receipted operation) before narrowing the constraint; this script will not rewrite them to ''done''.',
            archived_rows;
    END IF;
END $$;

ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_status_check;

ALTER TABLE public.tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('todo','in_progress','review','blocked','done','cancelled'));

COMMENT ON COLUMN public.tasks.status IS NULL;
