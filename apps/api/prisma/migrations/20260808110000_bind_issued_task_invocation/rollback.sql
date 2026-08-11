-- Rollback is safe only while the issued-invocation relation remains unused.
DO $guard$
BEGIN
    IF EXISTS (SELECT 1 FROM public.task_result_bindings LIMIT 1) THEN
        RAISE EXCEPTION
            'ARCA-0195 issued-invocation rollback refused: bindings exist'
            USING ERRCODE = 'MUN01';
    END IF;
END;
$guard$;

DROP INDEX IF EXISTS public.idx_task_result_bindings_node;

ALTER TABLE public.task_result_bindings
    DROP CONSTRAINT IF EXISTS task_result_bindings_projection_bytes_check,
    DROP CONSTRAINT IF EXISTS task_result_bindings_card_bytes_check,
    DROP CONSTRAINT IF EXISTS task_result_bindings_operation_check,
    DROP CONSTRAINT IF EXISTS task_result_bindings_invocation_unique,
    DROP COLUMN IF EXISTS projection_canonical_bytes,
    DROP COLUMN IF EXISTS card_canonical_bytes,
    DROP COLUMN IF EXISTS operation,
    DROP COLUMN IF EXISTS tenant_id,
    DROP COLUMN IF EXISTS node_id,
    DROP COLUMN IF EXISTS invocation_id;
