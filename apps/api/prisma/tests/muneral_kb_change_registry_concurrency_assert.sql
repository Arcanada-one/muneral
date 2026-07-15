\set ON_ERROR_STOP on

DO $test$
DECLARE
    v_expected bigint[] := ARRAY[6, 9, 21, 7, 6, 16]::bigint[];
    v_actual bigint[];
    v_project_order uuid[];
    v_dependency_order uuid[];
BEGIN
    SELECT pg_catalog.array_agg(changes.revision ORDER BY changes.task_id)
    INTO v_actual
    FROM public.muneral_kb_task_changes AS changes;

    IF v_actual IS DISTINCT FROM v_expected THEN
        RAISE EXCEPTION 'concurrent revision mismatch: expected %, got %',
            v_expected, v_actual;
    END IF;
    IF (SELECT name FROM public.projects
        WHERE id = '30000000-0000-0000-0000-000000000001'::uuid)
       <> 'concurrent project update' THEN
        RAISE EXCEPTION 'concurrent project transaction did not commit';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM public.task_dependencies
        WHERE id = 'd0000000-0000-0000-0000-000000000007'::uuid
          AND from_task_id = 'a0000000-0000-0000-0000-000000000001'::uuid
          AND to_task_id = 'a0000000-0000-0000-0000-000000000002'::uuid
    ) THEN
        RAISE EXCEPTION 'concurrent dependency transaction did not commit';
    END IF;

    SELECT pg_catalog.array_agg(lock_order.task_id ORDER BY lock_order.sequence)
    INTO v_project_order
    FROM public.muneral_kb_smoke_lock_order AS lock_order
    WHERE lock_order.application_name = 'ltm-project';
    IF v_project_order IS DISTINCT FROM ARRAY[
        'a0000000-0000-0000-0000-000000000001'::uuid,
        'a0000000-0000-0000-0000-000000000002'::uuid,
        'a0000000-0000-0000-0000-000000000003'::uuid,
        'a0000000-0000-0000-0000-000000000004'::uuid,
        'a0000000-0000-0000-0000-000000000005'::uuid,
        'a0000000-0000-0000-0000-000000000006'::uuid
    ] THEN
        RAISE EXCEPTION 'project lock order is not ascending: %', v_project_order;
    END IF;

    SELECT pg_catalog.array_agg(lock_order.task_id ORDER BY lock_order.sequence)
    INTO v_dependency_order
    FROM public.muneral_kb_smoke_lock_order AS lock_order
    WHERE lock_order.application_name = 'ltm-dependency';
    IF v_dependency_order IS DISTINCT FROM ARRAY[
        'a0000000-0000-0000-0000-000000000001'::uuid,
        'a0000000-0000-0000-0000-000000000002'::uuid
    ] THEN
        RAISE EXCEPTION 'dependency lock order is not ascending: %',
            v_dependency_order;
    END IF;
END;
$test$;

DROP TRIGGER muneral_kb_smoke_delay_registry_update
ON public.muneral_kb_task_changes;
DROP FUNCTION public.muneral_kb_smoke_delay_registry_update();
DROP TABLE public.muneral_kb_smoke_lock_order;

SELECT 'MUNERAL_KB_CONCURRENCY_PASS' AS result;
