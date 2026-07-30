-- MUN-0020: Additive execution-authority schema.
-- Three new tables extending the existing Task model with task-scoped
-- aggregate versioning, Muneral-issued attempt identity, immutable transition
-- journal with idempotency, and cross-attempt retry budget.
--
-- Additive only. No backfill, no existing-row rewrite.
-- The module is disabled-by-default (not wired into AppModule).

-- ---------------------------------------------------------------------------
-- task_execution_state — one row per task, the aggregate root
-- ---------------------------------------------------------------------------
CREATE TABLE public.task_execution_state (
    task_id             UUID        NOT NULL,
    aggregate_version   BIGINT      NOT NULL,
    current_attempt_id  UUID,
    retry_budget        INTEGER     NOT NULL DEFAULT 3,
    retry_count         INTEGER     NOT NULL DEFAULT 0,
    retry_backoff_ms    BIGINT      NOT NULL DEFAULT 0,
    retry_eligible_at   TIMESTAMPTZ,

    CONSTRAINT task_execution_state_pkey PRIMARY KEY (task_id),
    CONSTRAINT task_execution_state_version_check CHECK (aggregate_version > 0),
    CONSTRAINT task_execution_state_retry_budget_check CHECK (retry_budget >= 0 AND retry_budget <= 1000),
    CONSTRAINT task_execution_state_retry_count_check CHECK (retry_count >= 0 AND retry_count <= retry_budget),
    CONSTRAINT task_execution_state_retry_backoff_check CHECK (retry_backoff_ms >= 0 AND retry_backoff_ms <= 3600000)
);

-- ---------------------------------------------------------------------------
-- task_execution_attempts — Muneral-issued attempt identity
-- ---------------------------------------------------------------------------
CREATE TABLE public.task_execution_attempts (
    attempt_id    UUID          NOT NULL,
    task_id       UUID          NOT NULL,
    ordinal       INTEGER       NOT NULL,
    status        VARCHAR(32)   NOT NULL DEFAULT 'issued',
    issued_at     TIMESTAMPTZ   NOT NULL,
    started_at    TIMESTAMPTZ,
    completed_at  TIMESTAMPTZ,

    CONSTRAINT task_execution_attempts_pkey PRIMARY KEY (attempt_id),
    CONSTRAINT task_execution_attempts_task_ordinal_unique UNIQUE (task_id, ordinal),
    CONSTRAINT task_execution_attempts_status_check
        CHECK (status IN ('issued', 'running', 'succeeded', 'failed', 'cancelled')),
    CONSTRAINT task_execution_attempts_ordinal_check CHECK (ordinal > 0)
);

-- ---------------------------------------------------------------------------
-- task_execution_transitions — immutable append-only journal
-- ---------------------------------------------------------------------------
CREATE TABLE public.task_execution_transitions (
    id                  UUID          NOT NULL,
    task_id             UUID          NOT NULL,
    attempt_id          UUID          NOT NULL,
    aggregate_version   BIGINT        NOT NULL,
    event_type          VARCHAR(64)   NOT NULL,
    idempotency_key     VARCHAR(256)  NOT NULL,
    command_digest      VARCHAR(64)   NOT NULL,
    transition_payload  JSONB         NOT NULL DEFAULT '{}',
    committed_result    JSONB         NOT NULL DEFAULT '{}',
    evidence_refs       JSONB         NOT NULL DEFAULT '[]',
    causation_id        VARCHAR(256)  NOT NULL,
    correlation_id      VARCHAR(256)  NOT NULL,
    recorded_at         TIMESTAMPTZ   NOT NULL,

    CONSTRAINT task_execution_transitions_pkey PRIMARY KEY (id),
    CONSTRAINT task_execution_transitions_task_version_unique
        UNIQUE (task_id, aggregate_version),
    CONSTRAINT task_execution_transitions_task_idempotency_unique
        UNIQUE (task_id, idempotency_key),
    CONSTRAINT task_execution_transitions_version_check
        CHECK (aggregate_version > 0),
    CONSTRAINT task_execution_transitions_event_type_check
        CHECK (event_type IN (
            'attempt:issued',
            'attempt:started',
            'attempt:succeeded',
            'attempt:failed',
            'attempt:cancelled',
            'attempt:retry_issued'
        ))
);

-- ---------------------------------------------------------------------------
-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
CREATE INDEX idx_task_exec_attempts_task_id
    ON public.task_execution_attempts(task_id);

CREATE INDEX idx_task_exec_transitions_task_id
    ON public.task_execution_transitions(task_id);

CREATE INDEX idx_task_exec_transitions_attempt_id
    ON public.task_execution_transitions(attempt_id);

-- ---------------------------------------------------------------------------
-- Task-consistent composite unique key on attempts
-- ---------------------------------------------------------------------------
-- Enables a composite FK from transitions(attempt_id, task_id) so a
-- transition cannot reference an attempt that belongs to a different task.
ALTER TABLE public.task_execution_attempts
    ADD CONSTRAINT task_execution_attempts_attempt_task_unique
    UNIQUE (attempt_id, task_id);

-- ---------------------------------------------------------------------------
-- Foreign keys (additive — reference the existing tasks table)
-- ---------------------------------------------------------------------------
ALTER TABLE public.task_execution_state
    ADD CONSTRAINT task_execution_state_task_id_fkey
    FOREIGN KEY (task_id) REFERENCES public.tasks(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE public.task_execution_attempts
    ADD CONSTRAINT task_execution_attempts_task_id_fkey
    FOREIGN KEY (task_id) REFERENCES public.tasks(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE public.task_execution_transitions
    ADD CONSTRAINT task_execution_transitions_task_id_fkey
    FOREIGN KEY (task_id) REFERENCES public.tasks(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Composite FK: transitions(attempt_id, task_id) → attempts(attempt_id, task_id).
-- Prevents a transition from referencing an attempt that belongs to a
-- different task — the journal invariant is enforced at the database level.
-- RESTRICT: journal facts cannot be silently cascade-deleted.
ALTER TABLE public.task_execution_transitions
    ADD CONSTRAINT task_execution_transitions_attempt_task_fkey
    FOREIGN KEY (attempt_id, task_id)
    REFERENCES public.task_execution_attempts(attempt_id, task_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- DEFERRABLE FK: state(current_attempt_id, task_id) → attempts(attempt_id, task_id).
-- Initiated DEFERRED so the service can write state then attempt within a
-- single transaction and the constraint is checked only at commit time.
ALTER TABLE public.task_execution_state
    ADD CONSTRAINT task_execution_state_current_attempt_fkey
    FOREIGN KEY (current_attempt_id, task_id)
    REFERENCES public.task_execution_attempts(attempt_id, task_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
    DEFERRABLE INITIALLY DEFERRED;

-- ---------------------------------------------------------------------------
-- Append-only guard trigger — rejects UPDATE and DELETE on journal
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.task_execution_transitions_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'task_execution_transitions is append-only: UPDATE rejected for id=%', OLD.id
            USING ERRCODE = 'MUN00'; -- custom SQLSTATE for guard-specific catch
    ELSIF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'task_execution_transitions is append-only: DELETE rejected for id=%', OLD.id
            USING ERRCODE = 'MUN00';
    END IF;
    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.task_execution_transitions_guard() FROM PUBLIC;

CREATE TRIGGER task_execution_transitions_append_only
BEFORE UPDATE OR DELETE ON public.task_execution_transitions
FOR EACH ROW EXECUTE FUNCTION public.task_execution_transitions_guard();
