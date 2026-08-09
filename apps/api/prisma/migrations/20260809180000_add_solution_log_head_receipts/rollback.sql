-- ARCA-0198 solution-log head receipt migration is forward-only.
-- Removing this schema would destroy producer-authenticated provenance or
-- weaken its append-only guards. Disposable tests must recreate their isolated
-- database instead. This rollback intentionally never succeeds.

DO $$
BEGIN
  RAISE EXCEPTION
    'ARCA-0198 solution-log head receipt migration is forward-only. '
    'Append-only producer provenance cannot be rolled back; recreate the '
    'isolated database to clean up a disposable test environment.';
END;
$$;
