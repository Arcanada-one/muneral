-- MUN-0020 execution-authority disposable PostgreSQL smoke tests.
-- Run inside a transaction for each numbered proof; SELECT 'PASS' markers
-- at the end of each block confirm the test succeeded.
-- Failures use RAISE EXCEPTION so the harness sees a non-zero exit.
--
-- ORDERING CONTRACT (deliberate, not accidental)
-- ---------------------------------------------------------------------------
-- These proofs are ONE ordered scenario against a freshly migrated, freshly
-- preseeded disposable database, not a set of independent cases. Proof 1
-- establishes the task-1 aggregate (state + attempt b1 + journal v1); proofs
-- 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13 and 14 read or extend it, and proof 7
-- advances it to version 2. Running them out of order, or skipping a
-- predecessor, is not supported.
--
-- Every dependent proof therefore opens with an explicit PRECONDITION check
-- that RAISEs if the state its predecessor should have established is absent.
-- That is what stops a dependent proof from silently "passing" (e.g. an
-- expected unique-violation that never fires because the conflicting row was
-- never inserted) when its predecessor did not run.
--
-- Full self-containment was considered and rejected: it would require every
-- proof to re-seed a private task plus aggregate, roughly tripling the file
-- for no additional contract coverage, since the database-level invariants
-- under test (uniqueness, triggers, FK actions) are task-agnostic.

-- Proof 1: Initial attempt issuance creates state, attempt, transition atomically
-- within one transaction.
-- SCENARIO ROOT — establishes the task-1 aggregate every later proof depends on.
DO $$
DECLARE
  v_state_count  INTEGER;
  v_attempt_count INTEGER;
  v_transition_count INTEGER;
  v_version      BIGINT;
BEGIN
  -- Issue initial attempt for task-1
  INSERT INTO public.task_execution_state
    (task_id, aggregate_version, current_attempt_id, retry_budget, retry_count, retry_backoff_ms)
  VALUES
    ('a0000000-0000-0000-0000-000000000001', 1, 'b0000000-0000-0000-0000-000000000001', 3, 0, 1000);

  INSERT INTO public.task_execution_attempts
    (attempt_id, task_id, ordinal, status, issued_at)
  VALUES
    ('b0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 1, 'issued', clock_timestamp());

  INSERT INTO public.task_execution_transitions
    (id, task_id, attempt_id, aggregate_version, event_type, idempotency_key,
     command_digest, transition_payload, committed_result, causation_id, correlation_id, recorded_at)
  VALUES
    ('c0000000-0000-0000-0000-000000000001',
     'a0000000-0000-0000-0000-000000000001',
     'b0000000-0000-0000-0000-000000000001',
     1,
     'attempt:issued',
     'idem-smoke-1',
     'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
     '{"retryBudget": 3, "retryBackoffMs": 1000}',
     '{}',
     'cause-smoke-1',
     'corr-smoke-1',
     clock_timestamp());

  -- Readback: verify all three rows exist
  SELECT count(*) INTO v_state_count FROM public.task_execution_state
    WHERE task_id = 'a0000000-0000-0000-0000-000000000001';
  SELECT count(*) INTO v_attempt_count FROM public.task_execution_attempts
    WHERE task_id = 'a0000000-0000-0000-0000-000000000001';
  SELECT count(*) INTO v_transition_count FROM public.task_execution_transitions
    WHERE task_id = 'a0000000-0000-0000-0000-000000000001';

  IF v_state_count != 1 THEN
    RAISE EXCEPTION 'Proof 1: state count = % (expected 1)', v_state_count;
  END IF;
  IF v_attempt_count != 1 THEN
    RAISE EXCEPTION 'Proof 1: attempt count = % (expected 1)', v_attempt_count;
  END IF;
  IF v_transition_count != 1 THEN
    RAISE EXCEPTION 'Proof 1: transition count = % (expected 1)', v_transition_count;
  END IF;

  -- Verify version is 1
  SELECT aggregate_version INTO v_version FROM public.task_execution_state
    WHERE task_id = 'a0000000-0000-0000-0000-000000000001';
  IF v_version != 1 THEN
    RAISE EXCEPTION 'Proof 1: version = % (expected 1)', v_version;
  END IF;

  RAISE NOTICE 'MUNERAL_EXEC_AUTH_PROOF_1_PASS';
END;
$$;

-- Proof 2: (task_id, aggregate_version) uniqueness — inserting duplicate version fails
-- DEPENDS ON PROOF 1 for the conflicting (task-1, version 1) journal row.
DO $$
BEGIN
  -- PRECONDITION: without proof 1's row there is nothing to collide with and
  -- the insert below would succeed, so the proof must refuse to run.
  IF NOT EXISTS (
    SELECT 1 FROM public.task_execution_transitions
    WHERE task_id = 'a0000000-0000-0000-0000-000000000001' AND aggregate_version = 1
  ) THEN
    RAISE EXCEPTION 'Proof 2 precondition: proof 1 journal row (task-1, v1) is missing';
  END IF;

  INSERT INTO public.task_execution_transitions
    (id, task_id, attempt_id, aggregate_version, event_type, idempotency_key,
     command_digest, transition_payload, committed_result, causation_id, correlation_id, recorded_at)
  VALUES
    ('c0000000-0000-0000-0000-000000000009',
     'a0000000-0000-0000-0000-000000000001',
     'b0000000-0000-0000-0000-000000000001',
     1,  -- same version as Proof 1
     'attempt:started',
     'idem-smoke-2',
     'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
     '{}',
     '{}',
     'cause-smoke-2',
     'corr-smoke-2',
     clock_timestamp());
  RAISE EXCEPTION 'Proof 2: should have failed with unique violation';
EXCEPTION
  WHEN unique_violation THEN
    RAISE NOTICE 'MUNERAL_EXEC_AUTH_PROOF_2_PASS';
END;
$$;

-- Proof 3: (task_id, idempotency_key) uniqueness — reusing key with different digest fails
-- DEPENDS ON PROOF 1 for the conflicting (task-1, 'idem-smoke-1') journal row.
DO $$
BEGIN
  -- PRECONDITION: without proof 1's row the key is not in use and the insert
  -- below would succeed, so the proof must refuse to run.
  IF NOT EXISTS (
    SELECT 1 FROM public.task_execution_transitions
    WHERE task_id = 'a0000000-0000-0000-0000-000000000001'
      AND idempotency_key = 'idem-smoke-1'
  ) THEN
    RAISE EXCEPTION 'Proof 3 precondition: proof 1 journal row (task-1, idem-smoke-1) is missing';
  END IF;

  INSERT INTO public.task_execution_transitions
    (id, task_id, attempt_id, aggregate_version, event_type, idempotency_key,
     command_digest, transition_payload, committed_result, causation_id, correlation_id, recorded_at)
  VALUES
    ('c0000000-0000-0000-0000-000000000010',
     'a0000000-0000-0000-0000-000000000001',
     'b0000000-0000-0000-0000-000000000001',
     2,
     'attempt:started',
     'idem-smoke-1',  -- same key as Proof 1
     'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
     '{}',
     '{}',
     'cause-smoke-3',
     'corr-smoke-3',
     clock_timestamp());
  RAISE EXCEPTION 'Proof 3: should have failed with unique violation';
EXCEPTION
  WHEN unique_violation THEN
    RAISE NOTICE 'MUNERAL_EXEC_AUTH_PROOF_3_PASS';
END;
$$;

-- Proof 4: Append-only trigger rejects UPDATE on journal
-- DEPENDS ON PROOF 1 for the target row.
DO $$
BEGIN
  -- PRECONDITION: an UPDATE matching zero rows fires no row-level trigger and
  -- would look identical to a rejected UPDATE, so require the row first.
  IF NOT EXISTS (
    SELECT 1 FROM public.task_execution_transitions
    WHERE id = 'c0000000-0000-0000-0000-000000000001'
  ) THEN
    RAISE EXCEPTION 'Proof 4 precondition: proof 1 journal row c1 is missing';
  END IF;

  UPDATE public.task_execution_transitions
    SET command_digest = 'tampered'
    WHERE id = 'c0000000-0000-0000-0000-000000000001';
  RAISE EXCEPTION 'Proof 4: should have been rejected by append-only trigger';
EXCEPTION
  WHEN SQLSTATE 'MUN00' THEN
    RAISE NOTICE 'MUNERAL_EXEC_AUTH_PROOF_4_PASS';
END;
$$;

-- Proof 5: Append-only trigger rejects DELETE on journal
-- DEPENDS ON PROOF 1 for the target row.
DO $$
DECLARE
  v_digest_after VARCHAR;
BEGIN
  -- PRECONDITION: a DELETE matching zero rows fires no row-level trigger and
  -- would look identical to a rejected DELETE, so require the row first.
  IF NOT EXISTS (
    SELECT 1 FROM public.task_execution_transitions
    WHERE id = 'c0000000-0000-0000-0000-000000000001'
  ) THEN
    RAISE EXCEPTION 'Proof 5 precondition: proof 1 journal row c1 is missing';
  END IF;

  DELETE FROM public.task_execution_transitions
    WHERE id = 'c0000000-0000-0000-0000-000000000001';
  RAISE EXCEPTION 'Proof 5: should have been rejected by append-only trigger';
EXCEPTION
  WHEN SQLSTATE 'MUN00' THEN
    -- Verify the row still exists (DELETE was rejected)
    SELECT command_digest INTO v_digest_after FROM public.task_execution_transitions
      WHERE id = 'c0000000-0000-0000-0000-000000000001';
    IF v_digest_after IS NULL THEN
      RAISE EXCEPTION 'Proof 5: row was deleted despite append-only trigger';
    END IF;
    RAISE NOTICE 'MUNERAL_EXEC_AUTH_PROOF_5_PASS';
END;
$$;

-- ---------------------------------------------------------------------------
-- Proofs 13 and 14 belong with proofs 4 and 5 (they close the third mutation
-- path on the same fact tables) and are placed here for locality. They carry
-- the numbers 13/14 rather than 6/7 so that the existing ordered scenario and
-- its harness marker list are not renumbered.
-- ---------------------------------------------------------------------------

-- Proof 13: statement-level TRUNCATE guard rejects TRUNCATE on the journal.
-- Regression proof for QA finding F1: the append-only trigger installed by
-- 20260730000000 is BEFORE UPDATE OR DELETE ... FOR EACH ROW. PostgreSQL treats
-- TRUNCATE as a distinct event that such a trigger never observes, so before
-- 20260731090000 this block emptied the journal outright.
-- DEPENDS ON PROOF 1 for a non-empty journal.
DO $$
DECLARE
  v_before INTEGER;
  v_after  INTEGER;
BEGIN
  SELECT count(*) INTO v_before FROM public.task_execution_transitions;
  -- PRECONDITION: TRUNCATE on an already-empty table destroys nothing, so an
  -- empty journal would make this proof vacuous.
  IF v_before < 1 THEN
    RAISE EXCEPTION 'Proof 13 precondition: journal is empty (proof 1 must run first)';
  END IF;

  -- 13a: plain TRUNCATE. On current main, MUN-0021's outbox table has an
  -- inbound FK to the journal, so PostgreSQL may refuse the statement before
  -- the direct guard fires. Proof 13b below uses CASCADE and therefore remains
  -- the load-bearing assertion that the MUN00 guard itself is active.
  BEGIN
    TRUNCATE public.task_execution_transitions;
    RAISE EXCEPTION 'Proof 13: TRUNCATE on the journal was not rejected';
  EXCEPTION
    WHEN feature_not_supported THEN
      NULL; -- inbound task_outbox_events FK refused the plain TRUNCATE
    WHEN SQLSTATE 'MUN00' THEN
      NULL;
  END;

  -- 13b: TRUNCATE ... CASCADE — the exact statement that reproduced finding F1
  BEGIN
    TRUNCATE public.task_execution_transitions CASCADE;
    RAISE EXCEPTION 'Proof 13: TRUNCATE ... CASCADE on the journal was not rejected';
  EXCEPTION
    WHEN SQLSTATE 'MUN00' THEN
      NULL;
  END;

  SELECT count(*) INTO v_after FROM public.task_execution_transitions;
  IF v_after != v_before THEN
    RAISE EXCEPTION
      'Proof 13: journal row count changed across rejected TRUNCATEs (before=%, after=%)',
      v_before, v_after;
  END IF;

  RAISE NOTICE 'MUNERAL_EXEC_AUTH_PROOF_13_PASS';
END;
$$;

-- Proof 14: the attempt fact table is equally non-destructible by TRUNCATE.
-- Plain TRUNCATE is refused by PostgreSQL itself (0A000) because attempts are
-- referenced by an inbound foreign key; TRUNCATE ... CASCADE gets past that and
-- is refused by the statement-level guard (MUN00). Both paths are asserted so
-- the guarantee does not silently degrade to depending on FK topology alone.
-- DEPENDS ON PROOF 1 for a non-empty attempt table.
DO $$
DECLARE
  v_before INTEGER;
  v_after  INTEGER;
  v_state  INTEGER;
BEGIN
  SELECT count(*) INTO v_before FROM public.task_execution_attempts;
  IF v_before < 1 THEN
    RAISE EXCEPTION 'Proof 14 precondition: attempt table is empty (proof 1 must run first)';
  END IF;

  -- 14a: plain TRUNCATE — refused by the inbound FK before any trigger fires
  BEGIN
    TRUNCATE public.task_execution_attempts;
    RAISE EXCEPTION 'Proof 14: TRUNCATE on attempts was not rejected';
  EXCEPTION
    WHEN feature_not_supported THEN
      NULL; -- "cannot truncate a table referenced in a foreign key constraint"
    WHEN SQLSTATE 'MUN00' THEN
      NULL; -- guard fired first — also acceptable
  END;

  -- 14b: TRUNCATE ... CASCADE — bypasses the FK refusal, must hit the guard
  BEGIN
    TRUNCATE public.task_execution_attempts CASCADE;
    RAISE EXCEPTION 'Proof 14: TRUNCATE ... CASCADE on attempts was not rejected';
  EXCEPTION
    WHEN SQLSTATE 'MUN00' THEN
      NULL;
  END;

  SELECT count(*) INTO v_after FROM public.task_execution_attempts;
  SELECT count(*) INTO v_state FROM public.task_execution_state;
  IF v_after != v_before THEN
    RAISE EXCEPTION
      'Proof 14: attempt row count changed across rejected TRUNCATEs (before=%, after=%)',
      v_before, v_after;
  END IF;
  -- The CASCADE in 14b would also have emptied state; the guard must abort the
  -- whole statement, leaving the cascaded tables intact too.
  IF v_state < 1 THEN
    RAISE EXCEPTION 'Proof 14: cascaded TRUNCATE emptied task_execution_state';
  END IF;

  RAISE NOTICE 'MUNERAL_EXEC_AUTH_PROOF_14_PASS';
END;
$$;

-- Proof 6: Atomic transaction rollback — an exception after journal insert
-- leaves no partial rows (simulates mid-transaction crash).
DO $$
DECLARE
  v_count_pre  INTEGER;
  v_count_post INTEGER;
BEGIN
  SELECT count(*) INTO v_count_pre FROM public.task_execution_transitions
    WHERE task_id = 'a0000000-0000-0000-0000-000000000002';

  BEGIN
    INSERT INTO public.task_execution_state
      (task_id, aggregate_version, current_attempt_id, retry_budget, retry_count, retry_backoff_ms)
    VALUES
      ('a0000000-0000-0000-0000-000000000002', 1, 'b0000000-0000-0000-0000-000000000002', 3, 0, 1000);

    INSERT INTO public.task_execution_attempts
      (attempt_id, task_id, ordinal, status, issued_at)
    VALUES
      ('b0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000002', 1, 'issued', clock_timestamp());

    INSERT INTO public.task_execution_transitions
      (id, task_id, attempt_id, aggregate_version, event_type, idempotency_key,
       command_digest, transition_payload, committed_result, causation_id, correlation_id, recorded_at)
    VALUES
      ('c0000000-0000-0000-0000-000000000002',
       'a0000000-0000-0000-0000-000000000002',
       'b0000000-0000-0000-0000-000000000002',
       1,
       'attempt:issued',
       'idem-smoke-abort',
       'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
       '{"retryBudget": 3, "retryBackoffMs": 1000}',
       '{}',
       'cause-smoke-abort',
       'corr-smoke-abort',
       clock_timestamp());

    -- Simulate a mid-transaction crash: raise an exception AFTER the writes
    RAISE EXCEPTION 'simulated mid-transaction crash';
  EXCEPTION
    WHEN raise_exception THEN
      -- Expected: the transaction should have rolled back
      NULL;
  END;

  SELECT count(*) INTO v_count_post FROM public.task_execution_transitions
    WHERE task_id = 'a0000000-0000-0000-0000-000000000002';

  IF v_count_pre != v_count_post THEN
    RAISE EXCEPTION 'Proof 6: pre=% post=% — partial state leaked', v_count_pre, v_count_post;
  END IF;

  -- Also verify no state or attempt rows leaked for task-2
  IF EXISTS (SELECT 1 FROM public.task_execution_state WHERE task_id = 'a0000000-0000-0000-0000-000000000002') THEN
    RAISE EXCEPTION 'Proof 6: execution state leaked for aborted task';
  END IF;
  IF EXISTS (SELECT 1 FROM public.task_execution_attempts WHERE attempt_id = 'b0000000-0000-0000-0000-000000000002') THEN
    RAISE EXCEPTION 'Proof 6: attempt leaked for aborted task';
  END IF;

  RAISE NOTICE 'MUNERAL_EXEC_AUTH_PROOF_6_PASS';
END;
$$;

-- Proof 7: Version advance — a second transition for task-1 with version 2 succeeds
-- DEPENDS ON PROOF 1 for the task-1 aggregate at version 1.
DO $$
DECLARE
  v_version BIGINT;
BEGIN
  -- PRECONDITION: the version-conditional UPDATE below asserts NOT FOUND, which
  -- would also fire if proof 1 never created the aggregate — a different bug.
  IF NOT EXISTS (
    SELECT 1 FROM public.task_execution_state
    WHERE task_id = 'a0000000-0000-0000-0000-000000000001' AND aggregate_version = 1
  ) THEN
    RAISE EXCEPTION 'Proof 7 precondition: task-1 aggregate is not at version 1';
  END IF;

  INSERT INTO public.task_execution_transitions
    (id, task_id, attempt_id, aggregate_version, event_type, idempotency_key,
     command_digest, transition_payload, committed_result, causation_id, correlation_id, recorded_at)
  VALUES
    ('c0000000-0000-0000-0000-000000000003',
     'a0000000-0000-0000-0000-000000000001',
     'b0000000-0000-0000-0000-000000000001',
     2,
     'attempt:started',
     'idem-smoke-started',
     'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
     '{}',
     '{"status": "running"}',
     'cause-smoke-started',
     'corr-smoke-started',
     clock_timestamp());

  UPDATE public.task_execution_state
    SET aggregate_version = 2
    WHERE task_id = 'a0000000-0000-0000-0000-000000000001'
      AND aggregate_version = 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Proof 7: version-conditional update did not match any row';
  END IF;

  -- Mirror ExecutionAuthorityService.updateAttemptOnTransition: an
  -- 'attempt:started' fact drives the attempt row to 'running' with started_at
  -- set. Without this the hand-written fixture diverges from the service and
  -- proof 9 would be comparing a journal replay against a stale attempt row.
  UPDATE public.task_execution_attempts
    SET status = 'running', started_at = clock_timestamp()
    WHERE attempt_id = 'b0000000-0000-0000-0000-000000000001';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Proof 7: attempt lifecycle update did not match any row';
  END IF;

  SELECT aggregate_version INTO v_version FROM public.task_execution_state
    WHERE task_id = 'a0000000-0000-0000-0000-000000000001';
  IF v_version != 2 THEN
    RAISE EXCEPTION 'Proof 7: version = % (expected 2)', v_version;
  END IF;

  RAISE NOTICE 'MUNERAL_EXEC_AUTH_PROOF_7_PASS';
END;
$$;

-- Proof 8: Stale version update — using wrong expected version returns 0 rows
-- DEPENDS ON PROOF 7 for the task-1 aggregate at version 2.
DO $$
DECLARE
  v_count INTEGER;
BEGIN
  -- PRECONDITION: "matched 0 rows" is also what a missing aggregate produces,
  -- so require the row to exist at the non-stale version first.
  IF NOT EXISTS (
    SELECT 1 FROM public.task_execution_state
    WHERE task_id = 'a0000000-0000-0000-0000-000000000001' AND aggregate_version = 2
  ) THEN
    RAISE EXCEPTION 'Proof 8 precondition: task-1 aggregate is not at version 2 (proof 7 must run first)';
  END IF;

  -- Try to update with stale version predicate (version is now 2, use 1)
  WITH updated AS (
    UPDATE public.task_execution_state
      SET aggregate_version = 3
      WHERE task_id = 'a0000000-0000-0000-0000-000000000001'
        AND aggregate_version = 1  -- stale!
      RETURNING 1
  )
  SELECT count(*) INTO v_count FROM updated;

  IF v_count != 0 THEN
    RAISE EXCEPTION 'Proof 8: stale update matched % rows (expected 0)', v_count;
  END IF;

  -- Verify version is still 2 (unchanged)
  IF (SELECT aggregate_version FROM public.task_execution_state
      WHERE task_id = 'a0000000-0000-0000-0000-000000000001') != 2 THEN
    RAISE EXCEPTION 'Proof 8: version was mutated by stale update';
  END IF;

  RAISE NOTICE 'MUNERAL_EXEC_AUTH_PROOF_8_PASS';
END;
$$;

-- Proof 15: Full attempt lifecycle through retry to success, written with the
-- same statement sequence ExecutionAuthorityService uses (journal append +
-- version-conditional state update + attempt lifecycle update).
-- Numbered 15 rather than 9 so the existing ordered scenario is not renumbered.
-- DEPENDS ON PROOFS 1 and 7 for the task-1 aggregate at version 2.
--
-- This advances task-1 from version 2 to version 6 and gives proof 9 a journal
-- with two attempts, a spent retry, and a cleared current attempt. Without that
-- richer shape proof 9 cannot discriminate the clearsCurrentAttempt() semantics
-- it asserts: with a single never-terminal attempt, the corrected rule and the
-- rule it replaced return the same answer.
DO $$
DECLARE
  v_version BIGINT;
  v_current UUID;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.task_execution_state
    WHERE task_id = 'a0000000-0000-0000-0000-000000000001' AND aggregate_version = 2
  ) THEN
    RAISE EXCEPTION 'Proof 15 precondition: task-1 aggregate is not at version 2';
  END IF;

  -- ---- v3: attempt:failed on b1 (a failed attempt REMAINS current) ----
  INSERT INTO public.task_execution_transitions
    (id, task_id, attempt_id, aggregate_version, event_type, idempotency_key,
     command_digest, transition_payload, committed_result, causation_id, correlation_id, recorded_at)
  VALUES
    ('c0000000-0000-0000-0000-000000000015',
     'a0000000-0000-0000-0000-000000000001',
     'b0000000-0000-0000-0000-000000000001',
     3, 'attempt:failed', 'idem-smoke-failed',
     '1111111111111111111111111111111111111111111111111111111111111111',
     '{}', '{}', 'cause-smoke-failed', 'corr-smoke-failed', clock_timestamp());

  UPDATE public.task_execution_state
    -- retry_eligible_at = now + retry_backoff_ms * 2^retry_count (retry_count = 0)
    SET aggregate_version = 3,
        retry_eligible_at = clock_timestamp() + make_interval(secs => 1000 / 1000.0)
    WHERE task_id = 'a0000000-0000-0000-0000-000000000001'
      AND aggregate_version = 2;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Proof 15: version-conditional update to v3 matched no row';
  END IF;

  UPDATE public.task_execution_attempts
    SET status = 'failed', completed_at = clock_timestamp()
    WHERE attempt_id = 'b0000000-0000-0000-0000-000000000001';

  -- ---- v4: attempt:retry_issued — Muneral issues attempt b2 ----
  INSERT INTO public.task_execution_attempts
    (attempt_id, task_id, ordinal, status, issued_at)
  VALUES
    ('b0000000-0000-0000-0000-000000000015',
     'a0000000-0000-0000-0000-000000000001', 2, 'issued', clock_timestamp());

  INSERT INTO public.task_execution_transitions
    (id, task_id, attempt_id, aggregate_version, event_type, idempotency_key,
     command_digest, transition_payload, committed_result, causation_id, correlation_id, recorded_at)
  VALUES
    ('c0000000-0000-0000-0000-000000000016',
     'a0000000-0000-0000-0000-000000000001',
     'b0000000-0000-0000-0000-000000000015',
     4, 'attempt:retry_issued', 'idem-smoke-retry',
     '2222222222222222222222222222222222222222222222222222222222222222',
     '{}', '{}', 'cause-smoke-retry', 'corr-smoke-retry', clock_timestamp());

  UPDATE public.task_execution_state
    SET aggregate_version = 4,
        current_attempt_id = 'b0000000-0000-0000-0000-000000000015',
        retry_count = retry_count + 1,
        retry_eligible_at = NULL
    WHERE task_id = 'a0000000-0000-0000-0000-000000000001'
      AND aggregate_version = 3;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Proof 15: version-conditional update to v4 matched no row';
  END IF;

  -- ---- v5: attempt:started on b2 (issued -> running) ----
  INSERT INTO public.task_execution_transitions
    (id, task_id, attempt_id, aggregate_version, event_type, idempotency_key,
     command_digest, transition_payload, committed_result, causation_id, correlation_id, recorded_at)
  VALUES
    ('c0000000-0000-0000-0000-000000000017',
     'a0000000-0000-0000-0000-000000000001',
     'b0000000-0000-0000-0000-000000000015',
     5, 'attempt:started', 'idem-smoke-retry-started',
     '3333333333333333333333333333333333333333333333333333333333333333',
     '{}', '{}', 'cause-smoke-retry-started', 'corr-smoke-retry-started', clock_timestamp());

  UPDATE public.task_execution_state
    SET aggregate_version = 5
    WHERE task_id = 'a0000000-0000-0000-0000-000000000001'
      AND aggregate_version = 4;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Proof 15: version-conditional update to v5 matched no row';
  END IF;

  UPDATE public.task_execution_attempts
    SET status = 'running', started_at = clock_timestamp()
    WHERE attempt_id = 'b0000000-0000-0000-0000-000000000015';

  -- ---- v6: attempt:succeeded on b2 — clearsCurrentAttempt() clears the pointer ----
  INSERT INTO public.task_execution_transitions
    (id, task_id, attempt_id, aggregate_version, event_type, idempotency_key,
     command_digest, transition_payload, committed_result, causation_id, correlation_id, recorded_at)
  VALUES
    ('c0000000-0000-0000-0000-000000000018',
     'a0000000-0000-0000-0000-000000000001',
     'b0000000-0000-0000-0000-000000000015',
     6, 'attempt:succeeded', 'idem-smoke-retry-succeeded',
     '4444444444444444444444444444444444444444444444444444444444444444',
     '{}', '{"ok": true}', 'cause-smoke-retry-succeeded', 'corr-smoke-retry-succeeded', clock_timestamp());

  UPDATE public.task_execution_state
    SET aggregate_version = 6,
        current_attempt_id = NULL
    WHERE task_id = 'a0000000-0000-0000-0000-000000000001'
      AND aggregate_version = 5;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Proof 15: version-conditional update to v6 matched no row';
  END IF;

  UPDATE public.task_execution_attempts
    SET status = 'succeeded', completed_at = clock_timestamp()
    WHERE attempt_id = 'b0000000-0000-0000-0000-000000000015';

  SELECT aggregate_version, current_attempt_id INTO v_version, v_current
    FROM public.task_execution_state
    WHERE task_id = 'a0000000-0000-0000-0000-000000000001';

  IF v_version != 6 THEN
    RAISE EXCEPTION 'Proof 15: final version = % (expected 6)', v_version;
  END IF;
  IF v_current IS NOT NULL THEN
    RAISE EXCEPTION 'Proof 15: current_attempt_id = % (expected NULL after success)', v_current;
  END IF;
  IF (SELECT retry_count FROM public.task_execution_state
      WHERE task_id = 'a0000000-0000-0000-0000-000000000001') != 1 THEN
    RAISE EXCEPTION 'Proof 15: retry_count did not advance to 1';
  END IF;

  RAISE NOTICE 'MUNERAL_EXEC_AUTH_PROOF_15_PASS';
END;
$$;

-- Proof 9: Journal sufficiency — rebuild the decision-bearing aggregate from
-- transition facts alone, canonicalize it, and compare its SHA-256 against the
-- SHA-256 of the same canonical shape built from the independently maintained
-- task_execution_state / task_execution_attempts rows.
-- DEPENDS ON PROOFS 1 and 7 for the task-1 journal and aggregate.
--
-- WHAT THIS PROVES: at the database level the journal is a sufficient authority
-- for the decision-bearing state. The two sides are produced by different
-- statements — journal INSERTs on one side, state/attempt INSERT+UPDATEs on the
-- other — and are required to agree byte-for-byte after canonicalization.
--
-- WHAT THIS DOES NOT PROVE: byte-parity with the TypeScript decisionHash().
-- That is covered by the service-path test
-- "replay decisionHash matches independently-constructed DB snapshot".
-- The earlier revision of this proof claimed a hash comparison, computed no
-- hash, compared v_canonical to nothing, and asserted only facts already
-- guaranteed by proofs 1 and 7 (QA finding F5).
--
-- SCOPE: timestamps are deliberately excluded from the canonical shape. The
-- service derives journal recorded_at and attempt issued_at/started_at/
-- completed_at from one injected clock reading, but this hand-written fixture
-- uses independent clock_timestamp() calls, so timestamps legitimately differ
-- between the two sides here.
--
-- REDUCER PARITY: the replay below mirrors execution-authority.reducer.ts and
-- execution-authority.replay.ts. Two divergences in the earlier revision are
-- fixed here:
--   * retryCount now counts 'attempt:retry_issued' facts, not (attempts - 1);
--   * currentAttemptId now follows clearsCurrentAttempt()
--     (execution-authority.types.ts) — only succeeded/cancelled clear it, and a
--     failed attempt REMAINS current so Muneral can authorize a retry against
--     it. The earlier revision selected the highest-ordinal attempt whose last
--     event was in (issued, started, failed), which is a different rule.
DO $$
DECLARE
  v_replay   JSONB;
  v_expected JSONB;
  v_mutated  JSONB;
  v_hash_replay   TEXT;
  v_hash_expected TEXT;
BEGIN
  -- PRECONDITION: both sides must exist, otherwise two NULLs would hash equal.
  IF NOT EXISTS (
    SELECT 1 FROM public.task_execution_state
    WHERE task_id = 'a0000000-0000-0000-0000-000000000001'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.task_execution_transitions
    WHERE task_id = 'a0000000-0000-0000-0000-000000000001'
  ) THEN
    RAISE EXCEPTION 'Proof 9 precondition: task-1 aggregate or journal is missing';
  END IF;

  -- ---- Side A: replay from journal facts only ----
  WITH t AS (
    SELECT * FROM public.task_execution_transitions
    WHERE task_id = 'a0000000-0000-0000-0000-000000000001'
  ),
  initial AS (
    SELECT
      task_id,
      (transition_payload->>'retryBudget')::int      AS retry_budget,
      (transition_payload->>'retryBackoffMs')::bigint AS retry_backoff_ms
    FROM t
    WHERE event_type = 'attempt:issued'
  ),
  issuance AS (
    -- One row per attempt, ordinal assigned in issuance order, exactly as the
    -- reducer assigns ordinals (1 for the initial attempt, +1 per retry).
    SELECT
      attempt_id,
      aggregate_version,
      ROW_NUMBER() OVER (ORDER BY aggregate_version) AS ordinal
    FROM t
    WHERE event_type IN ('attempt:issued', 'attempt:retry_issued')
  ),
  last_issuance AS (
    SELECT attempt_id, aggregate_version
    FROM issuance
    ORDER BY aggregate_version DESC
    LIMIT 1
  ),
  attempt_status AS (
    SELECT
      i.attempt_id,
      i.ordinal,
      COALESCE(
        (SELECT CASE t2.event_type
                  WHEN 'attempt:started'   THEN 'running'
                  WHEN 'attempt:succeeded' THEN 'succeeded'
                  WHEN 'attempt:failed'    THEN 'failed'
                  WHEN 'attempt:cancelled' THEN 'cancelled'
                END
         FROM t t2
         WHERE t2.attempt_id = i.attempt_id
           AND t2.event_type NOT IN ('attempt:issued', 'attempt:retry_issued')
         ORDER BY t2.aggregate_version DESC
         LIMIT 1),
        'issued'
      ) AS status
    FROM issuance i
  )
  SELECT jsonb_build_object(
    'taskId',           (SELECT task_id FROM initial),
    'aggregateVersion', (SELECT max(aggregate_version)::bigint FROM t),
    'currentAttemptId', (
      -- clearsCurrentAttempt(): cleared only by succeeded/cancelled recorded
      -- after the most recent issuance; failed keeps the attempt current.
      SELECT CASE
        WHEN EXISTS (
          SELECT 1 FROM t
          WHERE t.aggregate_version > li.aggregate_version
            AND t.event_type IN ('attempt:succeeded', 'attempt:cancelled')
        ) THEN NULL
        ELSE li.attempt_id
      END
      FROM last_issuance li
    ),
    'retryBudget',    (SELECT retry_budget FROM initial),
    'retryCount',     (SELECT count(*)::int FROM t WHERE event_type = 'attempt:retry_issued'),
    'retryBackoffMs', (SELECT retry_backoff_ms FROM initial),
    'attempts', (
      SELECT jsonb_agg(jsonb_build_object(
        'attemptId', a.attempt_id,
        'ordinal',   a.ordinal::int,
        'status',    a.status
      ) ORDER BY a.ordinal)
      FROM attempt_status a
    )
  ) INTO v_replay;

  -- ---- Side B: the independently maintained state and attempt rows ----
  SELECT jsonb_build_object(
    'taskId',           s.task_id,
    'aggregateVersion', s.aggregate_version,
    'currentAttemptId', s.current_attempt_id,
    'retryBudget',      s.retry_budget,
    'retryCount',       s.retry_count,
    'retryBackoffMs',   s.retry_backoff_ms,
    'attempts', (
      SELECT jsonb_agg(jsonb_build_object(
        'attemptId', a.attempt_id,
        'ordinal',   a.ordinal,
        'status',    a.status
      ) ORDER BY a.ordinal)
      FROM public.task_execution_attempts a
      WHERE a.task_id = s.task_id
    )
  ) INTO v_expected
  FROM public.task_execution_state s
  WHERE s.task_id = 'a0000000-0000-0000-0000-000000000001';

  IF v_replay IS NULL OR v_expected IS NULL THEN
    RAISE EXCEPTION 'Proof 9: canonical state is null (replay=%, expected=%)',
      v_replay, v_expected;
  END IF;

  -- jsonb text output is canonical: keys normalised and ordered deterministically.
  v_hash_replay   := encode(sha256(convert_to(v_replay::text,   'UTF8')), 'hex');
  v_hash_expected := encode(sha256(convert_to(v_expected::text, 'UTF8')), 'hex');

  IF v_hash_replay != v_hash_expected THEN
    RAISE EXCEPTION
      'Proof 9: journal replay hash % != independent snapshot hash %; replay=% expected=%',
      v_hash_replay, v_hash_expected, v_replay::text, v_expected::text;
  END IF;

  -- Negative control: a comparison that cannot fail proves nothing. Perturb one
  -- decision-bearing field and require the hashes to diverge.
  v_mutated := jsonb_set(
    v_replay, '{retryCount}',
    to_jsonb(((v_replay->>'retryCount')::int + 1))
  );
  IF encode(sha256(convert_to(v_mutated::text, 'UTF8')), 'hex') = v_hash_expected THEN
    RAISE EXCEPTION
      'Proof 9: hash comparison has no discriminating power — a perturbed replay still matched';
  END IF;

  RAISE NOTICE 'MUNERAL_EXEC_AUTH_PROOF_9_PASS';
END;
$$;

-- Proof 10: Transaction isolation — check that constraints span attempts properly
-- DEPENDS ON PROOF 1 for the conflicting (task-1, ordinal 1) attempt row.
DO $$
BEGIN
  -- PRECONDITION: without proof 1's attempt there is nothing to collide with
  -- and the insert below would succeed.
  IF NOT EXISTS (
    SELECT 1 FROM public.task_execution_attempts
    WHERE task_id = 'a0000000-0000-0000-0000-000000000001' AND ordinal = 1
  ) THEN
    RAISE EXCEPTION 'Proof 10 precondition: proof 1 attempt (task-1, ordinal 1) is missing';
  END IF;

  -- (task_id, ordinal) uniqueness on attempts
  INSERT INTO public.task_execution_attempts
    (attempt_id, task_id, ordinal, status, issued_at)
  VALUES
    ('b0000000-0000-0000-0000-000000000010', 'a0000000-0000-0000-0000-000000000001', 1, 'issued', clock_timestamp());
  RAISE EXCEPTION 'Proof 10: should have failed with unique violation on (task_id, ordinal)';
EXCEPTION
  WHEN unique_violation THEN
    RAISE NOTICE 'MUNERAL_EXEC_AUTH_PROOF_10_PASS';
END;
$$;

-- Proof 11: RESTRICT/NO ACTION semantics retain authoritative history.
-- Deleting either an attempt referenced by the journal or its parent task must
-- fail instead of cascading execution evidence away.
DO $$
-- DEPENDS ON PROOF 1 for the referenced attempt and its journal row.
DECLARE
  v_attempt_count INTEGER;
  v_transition_count INTEGER;
BEGIN
  -- PRECONDITION: a DELETE matching zero rows raises no restrict_violation and
  -- would be indistinguishable from a correctly refused delete.
  IF NOT EXISTS (
    SELECT 1 FROM public.task_execution_attempts
    WHERE attempt_id = 'b0000000-0000-0000-0000-000000000001'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.task_execution_transitions
    WHERE id = 'c0000000-0000-0000-0000-000000000001'
  ) THEN
    RAISE EXCEPTION 'Proof 11 precondition: proof 1 attempt b1 or journal row c1 is missing';
  END IF;

  BEGIN
    DELETE FROM public.task_execution_attempts
      WHERE attempt_id = 'b0000000-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'Proof 11: referenced attempt delete unexpectedly succeeded';
  EXCEPTION
    WHEN restrict_violation THEN
      NULL;
  END;

  BEGIN
    DELETE FROM public.tasks
      WHERE id = 'a0000000-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'Proof 11: task delete unexpectedly cascaded execution history';
  EXCEPTION
    WHEN restrict_violation THEN
      NULL;
  END;

  SELECT count(*) INTO v_attempt_count
    FROM public.task_execution_attempts
    WHERE attempt_id = 'b0000000-0000-0000-0000-000000000001';
  SELECT count(*) INTO v_transition_count
    FROM public.task_execution_transitions
    WHERE id = 'c0000000-0000-0000-0000-000000000001';

  IF v_attempt_count != 1 OR v_transition_count != 1 THEN
    RAISE EXCEPTION
      'Proof 11: RESTRICT delete lost history (attempts=%, transitions=%)',
      v_attempt_count, v_transition_count;
  END IF;

  RAISE NOTICE 'MUNERAL_EXEC_AUTH_PROOF_11_PASS';
END;
$$;

-- Proof 12: the composite transition-to-attempt FK rejects cross-task facts.
-- The task exists and the attempt exists, but they belong to different tasks;
-- only the (attempt_id, task_id) relation may reject this insert.
DO $$
-- DEPENDS ON PROOF 1 for attempt b1 (owned by task-1) and on the preseed for task-2.
DECLARE
  v_constraint TEXT;
BEGIN
  -- PRECONDITION: the insert must fail *because* b1 belongs to a different
  -- task. If b1 did not exist at all the same insert would be rejected by the
  -- attempt FK for the wrong reason, and if task-2 did not exist it would be
  -- rejected by the task FK — neither proves the composite relation.
  IF NOT EXISTS (
    SELECT 1 FROM public.task_execution_attempts
    WHERE attempt_id = 'b0000000-0000-0000-0000-000000000001'
      AND task_id = 'a0000000-0000-0000-0000-000000000001'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.tasks WHERE id = 'a0000000-0000-0000-0000-000000000002'
  ) THEN
    RAISE EXCEPTION 'Proof 12 precondition: attempt b1 (owned by task-1) or task-2 is missing';
  END IF;

  BEGIN
    INSERT INTO public.task_execution_transitions
      (id, task_id, attempt_id, aggregate_version, event_type, idempotency_key,
       command_digest, transition_payload, committed_result, causation_id,
       correlation_id, recorded_at)
    VALUES
      ('c0000000-0000-0000-0000-000000000012',
       'a0000000-0000-0000-0000-000000000002',
       'b0000000-0000-0000-0000-000000000001',
       1,
       'attempt:issued',
       'idem-smoke-cross-task',
       'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
       '{}',
       '{}',
       'cause-smoke-cross-task',
       'corr-smoke-cross-task',
       clock_timestamp());
    RAISE EXCEPTION 'Proof 12: cross-task transition unexpectedly succeeded';
  EXCEPTION
    WHEN foreign_key_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      IF v_constraint != 'task_execution_transitions_attempt_task_fkey' THEN
        RAISE EXCEPTION
          'Proof 12: wrong constraint rejected cross-task transition: %',
          v_constraint;
      END IF;
  END;

  IF EXISTS (
    SELECT 1 FROM public.task_execution_transitions
    WHERE id = 'c0000000-0000-0000-0000-000000000012'
  ) THEN
    RAISE EXCEPTION 'Proof 12: rejected cross-task transition left residue';
  END IF;

  RAISE NOTICE 'MUNERAL_EXEC_AUTH_PROOF_12_PASS';
END;
$$;

-- Final marker
SELECT 'MUNERAL_EXEC_AUTH_SMOKE_PASS' AS result;
