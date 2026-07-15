\set ON_ERROR_STOP on

DO $test$
BEGIN
    IF pg_catalog.to_regclass('public.muneral_kb_task_changes') IS NOT NULL THEN
        RAISE EXCEPTION 'registry table remains after rollback';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_proc AS proc
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = proc.pronamespace
        WHERE namespace.nspname = 'public'
          AND proc.proname LIKE 'muneral_kb_%'
    ) THEN
        RAISE EXCEPTION 'registry function remains after rollback';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_trigger
        WHERE tgname LIKE 'muneral_kb_%'
          AND NOT tgisinternal
    ) THEN
        RAISE EXCEPTION 'registry trigger remains after rollback';
    END IF;
    IF (SELECT count(*) FROM public.tasks) <> 6
       OR (SELECT count(*) FROM public.projects) <> 1
       OR (SELECT count(*) FROM public.users) <> 1 THEN
        RAISE EXCEPTION 'rollback changed domain data';
    END IF;
END;
$test$;

SELECT 'MUNERAL_KB_CHANGE_REGISTRY_ROLLBACK_PASS' AS result;
