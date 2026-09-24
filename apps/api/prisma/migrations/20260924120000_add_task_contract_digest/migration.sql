-- A2-267: a work item carries the KC2 contract it was admitted under.
--
-- Argana's /v1/intake resolves a client request into a KC2 contract and creates
-- a Muneral work item for it. `CreateTaskDto` had no field for the contract's
-- digest and the global validation pipe refuses undeclared properties with 400,
-- so the digest could only ride as a line inside `description` — readable by a
-- human, parseable only by a reader that knows Argana's line format. This column
-- makes it a first-class field an executing agent can read back and filter on.
--
-- Additive, nullable, no backfill: no existing task was created from a contract
-- this column could name. Existing digests living in descriptions are left
-- where they are; copying them would assert a binding nobody re-verified.
-- VARCHAR(71) = len('sha256:') + 64.
ALTER TABLE public.tasks ADD COLUMN contract_digest VARCHAR(71);

-- The same pattern CreateTaskDto enforces, held by the database too: the import
-- and migration paths write tasks without going through the DTO. On a column
-- that is NULL in every existing row this validates instantly.
ALTER TABLE public.tasks ADD CONSTRAINT tasks_contract_digest_format
  CHECK (contract_digest IS NULL OR contract_digest ~ '^sha256:[0-9a-f]{64}$');

-- Not unique: two work items may legitimately execute one contract (a retry
-- after a cancelled attempt), and that is the caller's decision, not the schema's.
CREATE INDEX idx_tasks_contract_digest ON public.tasks (contract_digest)
  WHERE contract_digest IS NOT NULL;

COMMENT ON COLUMN public.tasks.contract_digest IS
  'A2-267: KC2 contract digest (sha256:<64 lowercase hex>) this work item was admitted under; NULL when the task was not created from a contract.';
