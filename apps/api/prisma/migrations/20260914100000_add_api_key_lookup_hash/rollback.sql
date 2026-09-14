-- MUN-0051 rollback: the column is a derived lookup id; dropping it loses no
-- credential. Code from before MUN-0051 never reads it.
DROP INDEX IF EXISTS public.uq_api_keys_lookup_hash;
ALTER TABLE public.api_keys DROP COLUMN IF EXISTS lookup_hash;
