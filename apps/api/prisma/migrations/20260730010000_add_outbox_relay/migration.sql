-- MUN-0021: Additive transactional outbox, lease relay, delivery evidence,
-- quarantine, and consumer inbox schema.
-- Extends MUN-0020 execution-authority with atomically committed server-derived
-- typed outbox events, mutable single-writer fenced lease bookkeeping,
-- append-only delivery-attempt and quarantine evidence, and append-only
-- consumer deduplication.
--
-- Additive only. No backfill, no existing-row rewrite.
-- The module is disabled-by-default (not wired into AppModule).
-- This relay transports committed Muneral task facts only: no fleet registry,
-- lifecycle, placement, update, watchdog, telemetry aggregation, or direct
-- command routing.

-- ---------------------------------------------------------------------------
-- task_outbox_events — one row per committed transition (server-derived)
-- ---------------------------------------------------------------------------
CREATE TABLE public.task_outbox_events (
    id                  UUID          NOT NULL,
    task_id             UUID          NOT NULL,
    aggregate_version   BIGINT        NOT NULL,
    attempt_id          UUID          NOT NULL,
    transition_id       UUID          NOT NULL,
    event_type          VARCHAR(64)   NOT NULL,
    event_payload       JSONB         NOT NULL DEFAULT '{}',
    recorded_at         TIMESTAMPTZ   NOT NULL,

    CONSTRAINT task_outbox_events_pkey PRIMARY KEY (id),
    CONSTRAINT task_outbox_events_transition_unique UNIQUE (transition_id),
    CONSTRAINT task_outbox_events_task_transition_unique UNIQUE (task_id, transition_id),
    CONSTRAINT task_outbox_events_version_check CHECK (aggregate_version > 0),
    CONSTRAINT task_outbox_events_event_type_check
        CHECK (event_type IN (
            'task:completed',
            'task:failed',
            'task:terminal_failed',
            'task:cancelled'
        ))
);

-- ---------------------------------------------------------------------------
-- outbox_leases — mutable fenced delivery bookkeeping
-- ---------------------------------------------------------------------------
-- Fenced: every status mutation must match lease_holder + delivery_ordinal
-- so a stale worker whose lease was reclaimed cannot commit after reclaim.
CREATE TABLE public.outbox_leases (
    outbox_event_id     UUID          NOT NULL,
    lease_holder        VARCHAR(128),
    lease_acquired_at   TIMESTAMPTZ,
    lease_expires_at    TIMESTAMPTZ,
    delivery_status     VARCHAR(32)   NOT NULL DEFAULT 'pending',
    delivery_ordinal    INTEGER       NOT NULL DEFAULT 0,
    failure_count       INTEGER       NOT NULL DEFAULT 0,
    last_error_code     VARCHAR(64),

    CONSTRAINT outbox_leases_pkey PRIMARY KEY (outbox_event_id),
    CONSTRAINT outbox_leases_status_check
        CHECK (delivery_status IN ('pending', 'leased', 'delivered', 'quarantined')),
    CONSTRAINT outbox_leases_ordinal_check CHECK (delivery_ordinal >= 0),
    CONSTRAINT outbox_leases_failure_count_check CHECK (failure_count >= 0),
    CONSTRAINT outbox_leases_expiry_order_check
        CHECK (lease_expires_at IS NULL OR lease_acquired_at IS NULL OR lease_expires_at > lease_acquired_at)
);

-- ---------------------------------------------------------------------------
-- delivery_attempt_evidence — append-only dispatch record
-- ---------------------------------------------------------------------------
CREATE TABLE public.delivery_attempt_evidence (
    id                UUID          NOT NULL,
    outbox_event_id   UUID          NOT NULL,
    delivery_ordinal  INTEGER       NOT NULL,
    disposition       VARCHAR(32)   NOT NULL,
    consumer_digest   VARCHAR(64),
    error_detail      JSONB,
    attempted_at      TIMESTAMPTZ   NOT NULL,

    CONSTRAINT delivery_attempt_evidence_pkey PRIMARY KEY (id),
    CONSTRAINT delivery_attempt_evidence_disposition_check
        CHECK (disposition IN ('delivered', 'quarantined', 'expired')),
    CONSTRAINT delivery_attempt_evidence_ordinal_check CHECK (delivery_ordinal >= 0)
);

-- ---------------------------------------------------------------------------
-- quarantine_evidence — append-only poison record
-- ---------------------------------------------------------------------------
CREATE TABLE public.quarantine_evidence (
    id                UUID          NOT NULL,
    outbox_event_id   UUID          NOT NULL,
    delivery_ordinal  INTEGER       NOT NULL,
    failure_count     INTEGER       NOT NULL,
    last_error_code   VARCHAR(64),
    last_error_detail JSONB,
    quarantined_at    TIMESTAMPTZ   NOT NULL,

    CONSTRAINT quarantine_evidence_pkey PRIMARY KEY (id),
    CONSTRAINT quarantine_evidence_outbox_unique UNIQUE (outbox_event_id),
    CONSTRAINT quarantine_evidence_failure_count_check CHECK (failure_count >= 1),
    CONSTRAINT quarantine_evidence_ordinal_check CHECK (delivery_ordinal >= 0)
);

-- ---------------------------------------------------------------------------
-- consumer_inbox — durable deduplication boundary
-- ---------------------------------------------------------------------------
CREATE TABLE public.consumer_inbox (
    consumer_id         VARCHAR(128)  NOT NULL,
    outbox_event_id     UUID          NOT NULL,
    consumed_at         TIMESTAMPTZ   NOT NULL,
    side_effect_digest  VARCHAR(64)   NOT NULL,

    CONSTRAINT consumer_inbox_pkey PRIMARY KEY (consumer_id, outbox_event_id),
    CONSTRAINT consumer_inbox_consumer_event_unique UNIQUE (consumer_id, outbox_event_id)
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
CREATE INDEX idx_task_outbox_events_task_id
    ON public.task_outbox_events(task_id);

CREATE INDEX idx_task_outbox_events_attempt_id
    ON public.task_outbox_events(attempt_id);

CREATE INDEX idx_task_outbox_events_recorded_at
    ON public.task_outbox_events(recorded_at);

CREATE INDEX idx_delivery_attempt_evidence_outbox
    ON public.delivery_attempt_evidence(outbox_event_id);

-- ---------------------------------------------------------------------------
-- Foreign keys (additive — RESTRICT prevents silent cascade-delete)
-- ---------------------------------------------------------------------------
ALTER TABLE public.task_outbox_events
    ADD CONSTRAINT task_outbox_events_task_id_fkey
    FOREIGN KEY (task_id) REFERENCES public.tasks(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE public.task_outbox_events
    ADD CONSTRAINT task_outbox_events_attempt_task_fkey
    FOREIGN KEY (attempt_id, task_id)
    REFERENCES public.task_execution_attempts(attempt_id, task_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE public.task_outbox_events
    ADD CONSTRAINT task_outbox_events_transition_fkey
    FOREIGN KEY (transition_id)
    REFERENCES public.task_execution_transitions(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE public.outbox_leases
    ADD CONSTRAINT outbox_leases_outbox_fkey
    FOREIGN KEY (outbox_event_id) REFERENCES public.task_outbox_events(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE public.delivery_attempt_evidence
    ADD CONSTRAINT delivery_attempt_evidence_outbox_fkey
    FOREIGN KEY (outbox_event_id) REFERENCES public.task_outbox_events(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE public.quarantine_evidence
    ADD CONSTRAINT quarantine_evidence_outbox_fkey
    FOREIGN KEY (outbox_event_id) REFERENCES public.task_outbox_events(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE public.consumer_inbox
    ADD CONSTRAINT consumer_inbox_outbox_fkey
    FOREIGN KEY (outbox_event_id) REFERENCES public.task_outbox_events(id)
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- Append-only guard triggers
-- ---------------------------------------------------------------------------

-- task_outbox_events — immutable after insert
CREATE FUNCTION public.task_outbox_events_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'task_outbox_events is append-only: UPDATE rejected for id=%', OLD.id
            USING ERRCODE = 'MUN00';
    ELSIF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'task_outbox_events is append-only: DELETE rejected for id=%', OLD.id
            USING ERRCODE = 'MUN00';
    END IF;
    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.task_outbox_events_guard() FROM PUBLIC;

CREATE TRIGGER task_outbox_events_append_only
BEFORE UPDATE OR DELETE ON public.task_outbox_events
FOR EACH ROW EXECUTE FUNCTION public.task_outbox_events_guard();

-- delivery_attempt_evidence — append-only
CREATE FUNCTION public.delivery_attempt_evidence_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'delivery_attempt_evidence is append-only: UPDATE rejected for id=%', OLD.id
            USING ERRCODE = 'MUN00';
    ELSIF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'delivery_attempt_evidence is append-only: DELETE rejected for id=%', OLD.id
            USING ERRCODE = 'MUN00';
    END IF;
    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.delivery_attempt_evidence_guard() FROM PUBLIC;

CREATE TRIGGER delivery_attempt_evidence_append_only
BEFORE UPDATE OR DELETE ON public.delivery_attempt_evidence
FOR EACH ROW EXECUTE FUNCTION public.delivery_attempt_evidence_guard();

-- quarantine_evidence — append-only
CREATE FUNCTION public.quarantine_evidence_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'quarantine_evidence is append-only: UPDATE rejected for id=%', OLD.id
            USING ERRCODE = 'MUN00';
    ELSIF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'quarantine_evidence is append-only: DELETE rejected for id=%', OLD.id
            USING ERRCODE = 'MUN00';
    END IF;
    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.quarantine_evidence_guard() FROM PUBLIC;

CREATE TRIGGER quarantine_evidence_append_only
BEFORE UPDATE OR DELETE ON public.quarantine_evidence
FOR EACH ROW EXECUTE FUNCTION public.quarantine_evidence_guard();

-- consumer_inbox — append-only
CREATE FUNCTION public.consumer_inbox_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'consumer_inbox is append-only: UPDATE rejected for consumer_id=%, outbox_event_id=%', OLD.consumer_id, OLD.outbox_event_id
            USING ERRCODE = 'MUN00';
    ELSIF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'consumer_inbox is append-only: DELETE rejected for consumer_id=%, outbox_event_id=%', OLD.consumer_id, OLD.outbox_event_id
            USING ERRCODE = 'MUN00';
    END IF;
    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.consumer_inbox_guard() FROM PUBLIC;

CREATE TRIGGER consumer_inbox_append_only
BEFORE UPDATE OR DELETE ON public.consumer_inbox
FOR EACH ROW EXECUTE FUNCTION public.consumer_inbox_guard();
