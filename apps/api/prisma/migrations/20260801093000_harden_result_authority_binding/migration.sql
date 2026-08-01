-- MUN-0021 independent-review remediation: durable pre-result authority.
--
-- This migration is additive and forward-only. It never learns authority from
-- an already-committed result. If the disabled result seam was used before an
-- authoritative binding existed, deployment stops for explicit reconciliation
-- rather than canonising the trust-on-first-use row.

DO $guard$
BEGIN
    IF EXISTS (SELECT 1 FROM public.task_result_nodes LIMIT 1)
       OR EXISTS (SELECT 1 FROM public.task_committed_result_refs LIMIT 1) THEN
        RAISE EXCEPTION
            'MUN-0021 result-binding migration refused: existing result rows require reconciliation against the authoritative Task Card source'
            USING ERRCODE = 'MUN01';
    END IF;
END;
$guard$;

CREATE TABLE public.task_result_bindings (
    task_id           UUID         NOT NULL,
    attempt_id        UUID         NOT NULL,
    card_id           VARCHAR(256) NOT NULL,
    card_digest       VARCHAR(64)  NOT NULL,
    projection_id     VARCHAR(256) NOT NULL,
    projection_digest VARCHAR(64)  NOT NULL,
    principal_id      VARCHAR(256) NOT NULL,
    recorded_at       TIMESTAMPTZ  NOT NULL,

    CONSTRAINT task_result_bindings_pkey
        PRIMARY KEY (task_id, attempt_id, card_id),
    CONSTRAINT task_result_bindings_authority_unique
        UNIQUE (task_id, attempt_id, card_id, card_digest,
                projection_id, projection_digest, principal_id),
    CONSTRAINT task_result_bindings_card_digest_check
        CHECK (card_digest ~ '^[0-9a-f]{64}$'),
    CONSTRAINT task_result_bindings_projection_digest_check
        CHECK (projection_digest ~ '^[0-9a-f]{64}$')
);

CREATE INDEX idx_task_result_bindings_attempt
    ON public.task_result_bindings(attempt_id);

ALTER TABLE public.task_result_bindings
    ADD CONSTRAINT task_result_bindings_task_id_fkey
    FOREIGN KEY (task_id) REFERENCES public.tasks(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE public.task_result_bindings
    ADD CONSTRAINT task_result_bindings_attempt_task_fkey
    FOREIGN KEY (attempt_id, task_id)
    REFERENCES public.task_execution_attempts(attempt_id, task_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Persist a server-derived digest over the complete closed adapter proposal.
-- The adapter cannot supply this column. Empty-table guard above makes NOT NULL
-- additive without fabricating values or backfilling from untrusted rows.
ALTER TABLE public.task_committed_result_refs
    ADD COLUMN mutation_digest VARCHAR(64) NOT NULL,
    ADD CONSTRAINT task_committed_result_refs_mutation_digest_check
        CHECK (mutation_digest ~ '^[0-9a-f]{64}$');

-- Database-level enforcement: even direct SQL cannot bind a committed result
-- to authority fields other than the exact pre-existing row.
ALTER TABLE public.task_committed_result_refs
    ADD CONSTRAINT task_committed_result_refs_binding_fkey
    FOREIGN KEY (task_id, attempt_id, card_id, card_digest,
                 projection_id, projection_digest, principal_id)
    REFERENCES public.task_result_bindings
        (task_id, attempt_id, card_id, card_digest,
         projection_id, projection_digest, principal_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION public.task_result_bindings_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION
            'task_result_bindings is append-only: UPDATE rejected for task=%, attempt=%, card=%',
            OLD.task_id, OLD.attempt_id, OLD.card_id
            USING ERRCODE = 'MUN00';
    ELSIF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION
            'task_result_bindings is append-only: DELETE rejected for task=%, attempt=%, card=%',
            OLD.task_id, OLD.attempt_id, OLD.card_id
            USING ERRCODE = 'MUN00';
    END IF;
    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.task_result_bindings_guard() FROM PUBLIC;

CREATE TRIGGER task_result_bindings_append_only
BEFORE UPDATE OR DELETE ON public.task_result_bindings
FOR EACH ROW EXECUTE FUNCTION public.task_result_bindings_guard();

-- UPDATE/DELETE row triggers do not observe TRUNCATE. Protect every MUN-0021
-- append-only fact with a statement-level guard, including the new binding.
CREATE FUNCTION public.muneral_append_only_truncate_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
    RAISE EXCEPTION
        'Muneral append-only fact table %.% is non-destructible: TRUNCATE rejected',
        TG_TABLE_SCHEMA, TG_TABLE_NAME
        USING ERRCODE = 'MUN00';
    RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.muneral_append_only_truncate_guard() FROM PUBLIC;

CREATE TRIGGER task_result_bindings_no_truncate
BEFORE TRUNCATE ON public.task_result_bindings
FOR EACH STATEMENT EXECUTE FUNCTION public.muneral_append_only_truncate_guard();

CREATE TRIGGER task_result_nodes_no_truncate
BEFORE TRUNCATE ON public.task_result_nodes
FOR EACH STATEMENT EXECUTE FUNCTION public.muneral_append_only_truncate_guard();

CREATE TRIGGER task_committed_result_refs_no_truncate
BEFORE TRUNCATE ON public.task_committed_result_refs
FOR EACH STATEMENT EXECUTE FUNCTION public.muneral_append_only_truncate_guard();

CREATE TRIGGER task_outbox_events_no_truncate
BEFORE TRUNCATE ON public.task_outbox_events
FOR EACH STATEMENT EXECUTE FUNCTION public.muneral_append_only_truncate_guard();

CREATE TRIGGER delivery_attempt_evidence_no_truncate
BEFORE TRUNCATE ON public.delivery_attempt_evidence
FOR EACH STATEMENT EXECUTE FUNCTION public.muneral_append_only_truncate_guard();

CREATE TRIGGER quarantine_evidence_no_truncate
BEFORE TRUNCATE ON public.quarantine_evidence
FOR EACH STATEMENT EXECUTE FUNCTION public.muneral_append_only_truncate_guard();

CREATE TRIGGER consumer_inbox_no_truncate
BEFORE TRUNCATE ON public.consumer_inbox
FOR EACH STATEMENT EXECUTE FUNCTION public.muneral_append_only_truncate_guard();

REVOKE INSERT, UPDATE, DELETE, TRUNCATE
ON public.task_result_bindings FROM PUBLIC;
