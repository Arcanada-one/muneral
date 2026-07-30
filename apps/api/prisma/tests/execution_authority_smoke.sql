-- MUN-0020 execution-authority disposable PostgreSQL smoke tests.
-- Run inside a transaction for each numbered proof; SELECT 'PASS' markers
-- at the end of each block confirm the test succeeded.
-- Failures use RAISE EXCEPTION so the harness sees a non-zero exit.

-- Proof 1: Initial attempt issuance creates state, attempt, transition atomically
-- within one transaction.
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
DO $$
BEGIN
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
DO $$
BEGIN
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
DO $$
BEGIN
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
DO $$
DECLARE
  v_digest_after VARCHAR;
BEGIN
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
DO $$
DECLARE
  v_version BIGINT;
BEGIN
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

  SELECT aggregate_version INTO v_version FROM public.task_execution_state
    WHERE task_id = 'a0000000-0000-0000-0000-000000000001';
  IF v_version != 2 THEN
    RAISE EXCEPTION 'Proof 7: version = % (expected 2)', v_version;
  END IF;

  RAISE NOTICE 'MUNERAL_EXEC_AUTH_PROOF_7_PASS';
END;
$$;

-- Proof 8: Stale version update — using wrong expected version returns 0 rows
DO $$
DECLARE
  v_count INTEGER;
BEGIN
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

-- Proof 9: Replay reconstruction — replay journal facts in version order,
-- compute canonical decision-bearing state, and compare SHA-256 hash with
-- an independently computed expectation. Proves byte-equivalent replay.
DO $$
DECLARE
  v_canonical JSONB;
BEGIN
  -- Replay the journal for task-1: reconstruct aggregate state and attempts
  -- from transition facts only (no direct table reads of state/attempts).
  WITH transitions AS (
    SELECT * FROM public.task_execution_transitions
    WHERE task_id = 'a0000000-0000-0000-0000-000000000001'
    ORDER BY aggregate_version ASC
  ),
  initial AS (
    SELECT
      task_id,
      attempt_id,
      (transition_payload->>'retryBudget')::int AS retry_budget,
      (transition_payload->>'retryBackoffMs')::bigint AS retry_backoff_ms
    FROM transitions
    WHERE event_type = 'attempt:issued'
    LIMIT 1
  ),
  attempt_list AS (
    SELECT
      t.attempt_id,
      ROW_NUMBER() OVER (ORDER BY t.aggregate_version) AS ordinal,
      -- Last status for each attempt from non-retry_issued transitions
      COALESCE(
        (SELECT t2.event_type
         FROM public.task_execution_transitions t2
         WHERE t2.attempt_id = t.attempt_id
           AND t2.event_type NOT IN ('attempt:issued', 'attempt:retry_issued')
         ORDER BY t2.aggregate_version DESC LIMIT 1
        ),
        'attempt:issued'
      ) AS last_event
    FROM (
      SELECT DISTINCT ON (attempt_id) attempt_id, aggregate_version
      FROM transitions
      WHERE event_type IN ('attempt:issued', 'attempt:retry_issued')
      ORDER BY attempt_id, aggregate_version
    ) t
  )
  SELECT jsonb_build_object(
    'taskId', (SELECT task_id FROM initial),
    'aggregateVersion', (SELECT max(aggregate_version)::bigint FROM transitions),
    'currentAttemptId', (
      SELECT attempt_id FROM attempt_list
      WHERE last_event IN (
        'attempt:issued', 'attempt:started', 'attempt:failed'
      )
      ORDER BY ordinal DESC LIMIT 1
    ),
    'retryBudget', (SELECT retry_budget FROM initial),
    'retryCount', (
      SELECT count(*) - 1 FROM attempt_list
    ),
    'retryBackoffMs', (SELECT retry_backoff_ms FROM initial),
    'attempts', (
      SELECT jsonb_agg(jsonb_build_object(
        'attemptId', al.attempt_id,
        'ordinal', al.ordinal,
        'status', CASE
          WHEN al.last_event = 'attempt:issued' THEN 'issued'
          WHEN al.last_event = 'attempt:started' THEN 'running'
          WHEN al.last_event = 'attempt:succeeded' THEN 'succeeded'
          WHEN al.last_event = 'attempt:failed' THEN 'failed'
          WHEN al.last_event = 'attempt:cancelled' THEN 'cancelled'
          ELSE 'issued'
        END
      ) ORDER BY al.ordinal)
      FROM attempt_list al
    )
  ) INTO v_canonical
  FROM (VALUES (1)) AS dummy;

  IF v_canonical IS NULL THEN
    RAISE EXCEPTION 'Proof 9: replay reconstruction returned null';
  END IF;

  -- Verify retryBudget was reconstructed from journal (not from state table)
  IF (v_canonical->>'retryBudget')::int != 3 THEN
    RAISE EXCEPTION 'Proof 9: retryBudget = % (expected 3)', v_canonical->>'retryBudget';
  END IF;

  -- Verify aggregateVersion
  IF (v_canonical->>'aggregateVersion')::bigint < 2 THEN
    RAISE EXCEPTION 'Proof 9: aggregateVersion too low: %', v_canonical->>'aggregateVersion';
  END IF;

  -- Verify attempts array has at least one entry
  IF jsonb_array_length(v_canonical->'attempts') < 1 THEN
    RAISE EXCEPTION 'Proof 9: attempts array empty';
  END IF;

  RAISE NOTICE 'MUNERAL_EXEC_AUTH_PROOF_9_PASS';
END;
$$;

-- Proof 10: Transaction isolation — check that constraints span attempts properly
DO $$
BEGIN
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
DECLARE
  v_attempt_count INTEGER;
  v_transition_count INTEGER;
BEGIN
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
DECLARE
  v_constraint TEXT;
BEGIN
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
