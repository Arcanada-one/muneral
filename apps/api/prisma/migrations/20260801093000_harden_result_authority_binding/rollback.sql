-- MUN-0021 result-authority hardening is forward-only.
-- Removing the pre-result binding, mutation digest, composite foreign key or
-- append-only/TRUNCATE guards would re-open an accepted authority defect and
-- weaken retained evidence. Stop result acceptance instead of dropping facts.

DO $$
BEGIN
  RAISE EXCEPTION
    'MUN-0021 result-authority hardening is forward-only. '
    'The binding and immutable evidence guards cannot be rolled back; drop the '
    'entire database only in a disposable test environment.';
END;
$$;
