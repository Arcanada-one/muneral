-- A2-370 (AEV E03.03): the first real consumer of the MUN-0021 outbox.
--
-- Purpose. The outbox relay (apps/api/src/outbox/outbox.relay.ts) existed with
-- no consumer, so every event the task lifecycle wrote (MUN-0040:
-- PATCH /tasks/:taskId/status -> TaskExecutionRecorderService ->
-- ExecutionAuthorityService.executeCommand) stayed `pending` forever. This
-- table is the effect of the `work-outcome-ledger` consumer: one row per
-- delivered outcome event — `work.outcome.recorded` in the AEV event contract
-- (arcanada-universal-program contracts/autonomous-evolution/events.v1.json),
-- i.e. task:completed / task:failed / task:terminal_failed / task:cancelled.
-- It is the read model Evolutio and Probatio are named as consumers of.
--
-- Idempotency lives in consumer_inbox, NOT here. The row is written in the
-- same transaction as the consumer_inbox row (consumer_id, outbox_event_id),
-- whose primary key is the dedup boundary the contract declares. There is
-- deliberately no UNIQUE (outbox_event_id) on this table: the replay proof
-- (test/outbox-relay-wired.e2e.spec.ts) counts rows here, and a unique
-- constraint would hide a lost inbox check instead of showing it.
--
-- Additive only: no existing table or column changes, no backfill. Append-only
-- (UPDATE and DELETE rejected by trigger), ON DELETE RESTRICT to the outbox
-- event it records — the same discipline as consumer_inbox.

CREATE TABLE public.work_outcome_records (
    id UUID NOT NULL,
    outbox_event_id UUID NOT NULL,
    task_id UUID NOT NULL,
    attempt_id UUID NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    aggregate_version BIGINT NOT NULL,
    idempotency_key VARCHAR(256) NOT NULL,
    outcome_recorded_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ NOT NULL,

    CONSTRAINT work_outcome_records_pkey PRIMARY KEY (id),
    CONSTRAINT work_outcome_records_event_type_check CHECK (
        event_type IN ('task:completed', 'task:failed', 'task:terminal_failed', 'task:cancelled')
    ),
    CONSTRAINT work_outcome_records_outbox_event_fkey FOREIGN KEY (outbox_event_id)
        REFERENCES public.task_outbox_events(id) ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX idx_work_outcome_records_task_id ON public.work_outcome_records(task_id);
CREATE INDEX idx_work_outcome_records_outbox_event_id ON public.work_outcome_records(outbox_event_id);

CREATE FUNCTION public.work_outcome_records_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
    RAISE EXCEPTION 'work_outcome_records is append-only: % rejected for id=%', TG_OP, OLD.id
        USING ERRCODE = 'MUN00';
END;
$function$;

REVOKE ALL ON FUNCTION public.work_outcome_records_guard() FROM PUBLIC;

CREATE TRIGGER work_outcome_records_append_only
BEFORE UPDATE OR DELETE ON public.work_outcome_records
FOR EACH ROW EXECUTE FUNCTION public.work_outcome_records_guard();

COMMENT ON TABLE public.work_outcome_records IS
  'A2-370: effect of the work-outcome-ledger outbox consumer (AEV work.outcome.recorded). One row per delivered outcome event; dedup is consumer_inbox, not a constraint here.';
