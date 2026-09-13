-- MUN-0049 task_redactions is additive and holds no cleartext, so dropping it
-- loses only the idempotency record of each redaction; the 'task:redacted'
-- activity_log row written in the same transaction remains the audit record.
DROP INDEX IF EXISTS public.idx_task_redactions_task_id;
DROP TABLE IF EXISTS public.task_redactions;
