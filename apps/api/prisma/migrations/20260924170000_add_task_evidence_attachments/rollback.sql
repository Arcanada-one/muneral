-- A2-274 rollback. Drops the table and every attachment recorded in it. That is
-- a LOSS, not a no-op: the uri and the digest an executor attached exist nowhere
-- else in Muneral — the activity_log row written with each attachment
-- ('task:evidence_attached') carries the same fields in its payload and is the
-- only thing that survives this. Run by hand only; Prisma never applies it.
DROP TABLE IF EXISTS public.task_evidence_attachments;
