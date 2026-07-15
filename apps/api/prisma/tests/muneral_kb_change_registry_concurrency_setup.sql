\set ON_ERROR_STOP on

-- Seed one overlapping dependency before installing the smoke-only delay
-- trigger. The two concurrent sessions will then update the project and swap
-- this dependency's endpoints through opposite logical paths.
INSERT INTO public.task_dependencies(id, from_task_id, to_task_id, type)
VALUES (
    'd0000000-0000-0000-0000-000000000007',
    'a0000000-0000-0000-0000-000000000002',
    'a0000000-0000-0000-0000-000000000001',
    'depends_on'
);

CREATE TABLE public.muneral_kb_smoke_lock_order (
    sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    application_name text NOT NULL,
    task_id uuid NOT NULL
);

CREATE FUNCTION public.muneral_kb_smoke_delay_registry_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $test$
BEGIN
    -- The row lock has been acquired before this BEFORE UPDATE trigger runs.
    -- Record the actual per-session lock-touch order, then sleep to make the
    -- overlapping project/dependency execution window deterministic.
    INSERT INTO public.muneral_kb_smoke_lock_order(application_name, task_id)
    VALUES (pg_catalog.current_setting('application_name'), NEW.task_id);
    PERFORM pg_catalog.pg_sleep(0.05);
    RETURN NEW;
END;
$test$;

CREATE TRIGGER muneral_kb_smoke_delay_registry_update
BEFORE UPDATE ON public.muneral_kb_task_changes
FOR EACH ROW EXECUTE FUNCTION public.muneral_kb_smoke_delay_registry_update();
