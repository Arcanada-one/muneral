-- A2-267 rollback. Drops the column and every digest stored in it: the digest
-- still exists in Argana's intake response and, for work items Argana created,
-- as the `contract_digest:` line of the task description, so nothing is lost
-- that is not recorded elsewhere. Run by hand only; Prisma never applies it.
DROP INDEX IF EXISTS public.idx_tasks_contract_digest;
ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_contract_digest_format;
ALTER TABLE public.tasks DROP COLUMN IF EXISTS contract_digest;
