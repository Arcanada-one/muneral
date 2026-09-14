-- MUN-0051: keyed API-key lookup.
--
-- `AuthService.validateApiKey` used to load every non-revoked key and run
-- bcrypt against each until one matched: O(keys) bcrypt comparisons per agent
-- request. The raw key carries no id part (mun_sk_ + 32 hex of a UUIDv4), so
-- the lookup id has to be derived from the key itself: sha256 hex of the whole
-- raw key. It is not a secret — 122 random bits make the digest useless for
-- recovering the key — and bcrypt stays the verifier: the digest only chooses
-- which ONE stored hash to compare against.
--
-- Additive and nullable: existing keys cannot be back-filled here (only their
-- bcrypt hashes are stored), so they keep lookup_hash NULL and are filled on
-- their first successful use. The unique index permits any number of NULLs.
ALTER TABLE public.api_keys ADD COLUMN lookup_hash VARCHAR(64);
CREATE UNIQUE INDEX uq_api_keys_lookup_hash ON public.api_keys (lookup_hash);
