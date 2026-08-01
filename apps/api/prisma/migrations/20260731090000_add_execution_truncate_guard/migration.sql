-- MUN-0020 (QA remediation, finding F1): statement-level TRUNCATE guard for the
-- execution-authority fact tables.
--
-- 20260730000000_add_execution_authority installs
--   CREATE TRIGGER task_execution_transitions_append_only
--   BEFORE UPDATE OR DELETE ON public.task_execution_transitions FOR EACH ROW ...
-- PostgreSQL treats TRUNCATE as a distinct event that a row-level UPDATE/DELETE
-- trigger never observes, so `TRUNCATE public.task_execution_transitions CASCADE`
-- emptied the journal while the append-only guard was installed and enabled.
-- That defeats hard gate 2 ("no deletion ... of transition facts").
--
-- A TRUNCATE trigger MUST be BEFORE TRUNCATE ... FOR EACH STATEMENT, and in that
-- context neither OLD nor NEW exists. The existing guard function dereferences
-- OLD.id and returns NEW, so it cannot be reused; this migration adds a separate
-- statement-level guard function with the same hardening (SECURITY DEFINER,
-- fixed search_path, MUN00 SQLSTATE) and the same REVOKE.
--
-- Scope decision — which tables get the guard:
--   * task_execution_transitions: REQUIRED. Hard gate 2 and plan contract
--     decision 7 make transition facts non-deletable.
--   * task_execution_attempts: INCLUDED. Attempt rows are deliberately mutable
--     in place (status/started_at/completed_at), so they are not append-only,
--     but they are non-destructible: the plan requires a rollback that "never
--     deletes journal or attempt facts", and SQL proof 11 asserts that deleting
--     a journal-referenced attempt must fail. A statement-level TRUNCATE guard
--     constrains only the TRUNCATE event, so it enforces non-destruction without
--     touching the legitimate in-place status UPDATE. Before this migration the
--     attempts table was only *transitively* protected (plain TRUNCATE errors on
--     the inbound FK; TRUNCATE ... CASCADE reached the journal guard). The direct
--     trigger makes the guarantee explicit and independent of FK topology.
--   * task_execution_state: DELIBERATELY NOT GUARDED. It is a derived aggregate
--     that replayJournal() rebuilds from journal facts alone, no contract clause
--     covers it, and losing it fails closed (the next command's journal insert
--     collides on (task_id, aggregate_version), or the reducer returns
--     StaleVersionError). Guarding it would exceed the task contract.

CREATE FUNCTION public.task_execution_truncate_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
    -- Statement-level TRUNCATE trigger: OLD and NEW are both unavailable here,
    -- so identify the target from the trigger context instead.
    RAISE EXCEPTION
        'execution-authority fact table %.% is non-destructible: TRUNCATE rejected',
        TG_TABLE_SCHEMA, TG_TABLE_NAME
        USING ERRCODE = 'MUN00'; -- same guard-specific SQLSTATE as the append-only trigger
    RETURN NULL; -- unreachable; BEFORE TRUNCATE statement triggers ignore the value
END;
$function$;

REVOKE ALL ON FUNCTION public.task_execution_truncate_guard() FROM PUBLIC;

CREATE TRIGGER task_execution_transitions_no_truncate
BEFORE TRUNCATE ON public.task_execution_transitions
FOR EACH STATEMENT EXECUTE FUNCTION public.task_execution_truncate_guard();

CREATE TRIGGER task_execution_attempts_no_truncate
BEFORE TRUNCATE ON public.task_execution_attempts
FOR EACH STATEMENT EXECUTE FUNCTION public.task_execution_truncate_guard();
