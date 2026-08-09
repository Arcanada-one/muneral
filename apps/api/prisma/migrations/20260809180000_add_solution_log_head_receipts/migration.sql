-- ARCA-0198: producer-authenticated, provenance-only SolutionLog head receipts.
-- Additive and append-only. A receipt proves who recorded a head against
-- current Muneral execution state; it does not authorize model use.
CREATE TABLE public.solution_log_head_receipts (
    receipt_id VARCHAR(64) NOT NULL,
    task_id UUID NOT NULL,
    attempt_id UUID NOT NULL,
    principal_id UUID NOT NULL,
    task_revision BIGINT NOT NULL,
    projection_digest_sha256 VARCHAR(64) NOT NULL,
    log_revision INTEGER NOT NULL,
    previous_head_digest_sha256 VARCHAR(64),
    head_digest_sha256 VARCHAR(64) NOT NULL,
    solution_log_digest_sha256 VARCHAR(64) NOT NULL,
    execution_aggregate_version BIGINT NOT NULL,
    producer_version INTEGER NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL,
    provenance_scope VARCHAR(64) NOT NULL,
    model_use_status VARCHAR(32) NOT NULL,

    CONSTRAINT solution_log_head_receipts_pkey PRIMARY KEY (receipt_id),
    CONSTRAINT solution_log_head_receipts_producer_version_unique UNIQUE (task_id, attempt_id, producer_version),
    CONSTRAINT solution_log_head_receipts_log_revision_unique UNIQUE (task_id, attempt_id, log_revision),
    CONSTRAINT solution_log_head_receipts_head_unique UNIQUE (task_id, attempt_id, head_digest_sha256),
    CONSTRAINT solution_log_head_receipts_receipt_id_check CHECK (receipt_id ~ '^[0-9a-f]{64}$'),
    CONSTRAINT solution_log_head_receipts_projection_digest_check CHECK (projection_digest_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT solution_log_head_receipts_previous_head_digest_check CHECK (previous_head_digest_sha256 IS NULL OR previous_head_digest_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT solution_log_head_receipts_head_digest_check CHECK (head_digest_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT solution_log_head_receipts_log_digest_check CHECK (solution_log_digest_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT solution_log_head_receipts_task_revision_check CHECK (task_revision > 0),
    CONSTRAINT solution_log_head_receipts_log_revision_check CHECK (log_revision > 0),
    CONSTRAINT solution_log_head_receipts_execution_version_check CHECK (execution_aggregate_version > 0),
    CONSTRAINT solution_log_head_receipts_producer_version_check CHECK (producer_version > 0),
    CONSTRAINT solution_log_head_receipts_initial_head_check CHECK ((producer_version = 1) = (previous_head_digest_sha256 IS NULL)),
    CONSTRAINT solution_log_head_receipts_domain_separation_check CHECK (head_digest_sha256 <> projection_digest_sha256 AND solution_log_digest_sha256 <> projection_digest_sha256 AND solution_log_digest_sha256 <> head_digest_sha256),
    CONSTRAINT solution_log_head_receipts_provenance_check CHECK (provenance_scope = 'PRODUCER_AUTHENTICATED_ONLY'),
    CONSTRAINT solution_log_head_receipts_model_use_check CHECK (model_use_status = 'NOT_AUTHORIZED')
);

CREATE INDEX idx_solution_log_head_receipts_recorded_at ON public.solution_log_head_receipts(recorded_at);
CREATE INDEX idx_solution_log_head_receipts_principal ON public.solution_log_head_receipts(principal_id);

ALTER TABLE public.solution_log_head_receipts
    ADD CONSTRAINT solution_log_head_receipts_task_fkey
    FOREIGN KEY (task_id) REFERENCES public.tasks(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE public.solution_log_head_receipts
    ADD CONSTRAINT solution_log_head_receipts_attempt_task_fkey
    FOREIGN KEY (attempt_id, task_id)
    REFERENCES public.task_execution_attempts(attempt_id, task_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE public.solution_log_head_receipts
    ADD CONSTRAINT solution_log_head_receipts_principal_fkey
    FOREIGN KEY (principal_id) REFERENCES public.agents(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE public.solution_log_head_receipts
    ADD CONSTRAINT solution_log_head_receipts_previous_head_fkey
    FOREIGN KEY (task_id, attempt_id, previous_head_digest_sha256)
    REFERENCES public.solution_log_head_receipts(task_id, attempt_id, head_digest_sha256)
    ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION public.solution_log_head_receipts_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
    RAISE EXCEPTION 'solution_log_head_receipts is append-only: % rejected for receipt_id=%', TG_OP, OLD.receipt_id
        USING ERRCODE = 'MUN00';
    RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.solution_log_head_receipts_guard() FROM PUBLIC;

CREATE TRIGGER solution_log_head_receipts_append_only
BEFORE UPDATE OR DELETE ON public.solution_log_head_receipts
FOR EACH ROW EXECUTE FUNCTION public.solution_log_head_receipts_guard();

CREATE TRIGGER solution_log_head_receipts_no_truncate
BEFORE TRUNCATE ON public.solution_log_head_receipts
FOR EACH STATEMENT EXECUTE FUNCTION public.muneral_append_only_truncate_guard();

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.solution_log_head_receipts FROM PUBLIC;
