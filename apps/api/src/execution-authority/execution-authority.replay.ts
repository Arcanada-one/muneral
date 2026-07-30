// MUN-0020: Deterministic read-model rebuild from the immutable transition
// journal with fail-closed validation. Rejects malformed journal ordering,
// gaps, mixed task IDs, duplicate initial issuance, missing attempts, and
// invalid lifecycle edges.

import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json';
import type {
  AttemptStatus,
  TaskExecutionAttempt,
  TaskExecutionState,
  TaskExecutionTransition,
} from './execution-authority.types';
import {
  clearsCurrentAttempt,
  EVENT_TO_ATTEMPT_STATUS,
  isValidAttemptTransition,
  MAX_RETRY_BACKOFF_MS,
  MAX_RETRY_BUDGET,
} from './execution-authority.types';

/**
 * Rebuild the execution aggregate state and attempt list from an ordered set
 * of transition facts (ascending by aggregateVersion).
 *
 * Throws on structural violations:
 * - Empty transitions (silently returns null)
 * - Transitions not ordered by aggregateVersion with no gaps
 * - Mixed task IDs
 * - Duplicate initial issuance
 * - References to non-existent attempts
 * - Invalid lifecycle edges
 */
export function replayJournal(transitions: TaskExecutionTransition[]): {
  state: TaskExecutionState | null;
  attempts: TaskExecutionAttempt[];
} {
  if (transitions.length === 0) {
    return { state: null, attempts: [] };
  }

  // ---- Validate structural invariants ----
  const taskId = transitions[0].taskId;
  let expectedVersion = 1;
  let initialIssued = false;

  for (let i = 0; i < transitions.length; i++) {
    const t = transitions[i];

    // All transitions must have the same taskId
    if (t.taskId !== taskId) {
      throw new Error(
        `Replay invariant violation: mixed task IDs at index ${i}: ` +
          `expected ${taskId}, got ${t.taskId}`,
      );
    }

    // Monotonic version without gaps
    if (t.aggregateVersion !== expectedVersion) {
      throw new Error(
        `Replay invariant violation at index ${i}: ` +
          `expected aggregate_version ${expectedVersion}, got ${t.aggregateVersion}`,
      );
    }
    expectedVersion = t.aggregateVersion + 1;

    // Only one initial issuance
    if (t.eventType === 'attempt:issued') {
      if (initialIssued) {
        throw new Error(
          `Replay invariant violation at index ${i}: ` +
            `duplicate initial issuance for task ${taskId}`,
        );
      }
      if (i !== 0) {
        throw new Error(
          `Replay invariant violation at index ${i}: ` +
            `initial issuance must be the first transition`,
        );
      }
      initialIssued = true;
    }
  }

  // ---- Rebuild ----
  if (!initialIssued) {
    throw new Error(
      `Replay invariant violation: no initial issuance found for task ${taskId}`,
    );
  }

  let state: TaskExecutionState | null = null;
  const attempts: TaskExecutionAttempt[] = [];
  const attemptIndex = new Map<string, AttemptStatus>();
  const issuedAttempts = new Set<string>();

  for (const t of transitions) {
    if (t.eventType === 'attempt:issued') {
      state = buildInitialState(t);
      attempts.push({
        attemptId: t.attemptId,
        taskId: t.taskId,
        ordinal: 1,
        status: 'issued' as const,
        issuedAt: t.recordedAt,
        startedAt: null,
        completedAt: null,
      });
      attemptIndex.set(t.attemptId, 'issued');
      issuedAttempts.add(t.attemptId);
    } else if (t.eventType === 'attempt:retry_issued') {
      if (state === null) {
        throw new Error(
          `Replay invariant violation: retry_issued for task ${t.taskId} without prior issuance`,
        );
      }
      // Retry must issue a new, never-before-seen attempt ID
      if (issuedAttempts.has(t.attemptId)) {
        throw new Error(
          `Replay invariant violation at version ${t.aggregateVersion}: ` +
            `retry_issued reuses attempt ID ${t.attemptId}`,
        );
      }
      // Current attempt must be failed for retry to be valid
      const currentAttemptStatus = attemptIndex.get(
        state.currentAttemptId!,
      );
      if (currentAttemptStatus !== 'failed') {
        throw new Error(
          `Replay invariant violation at version ${t.aggregateVersion}: ` +
            `retry_issued but current attempt ${state.currentAttemptId} is ` +
            `${currentAttemptStatus ?? 'unknown'}, expected failed`,
        );
      }
      // Budget check
      if (state.retryCount >= state.retryBudget) {
        throw new Error(
          `Replay invariant violation at version ${t.aggregateVersion}: ` +
            `retry budget exhausted (${state.retryCount}/${state.retryBudget})`,
        );
      }
      // Backoff check: retry must not happen before retryEligibleAt
      if (
        state.retryEligibleAt !== null &&
        t.recordedAt.getTime() < state.retryEligibleAt.getTime()
      ) {
        throw new Error(
          `Replay invariant violation at version ${t.aggregateVersion}: ` +
            `retry_issued at ${t.recordedAt.toISOString()} before ` +
            `retryEligibleAt ${state.retryEligibleAt.toISOString()}`,
        );
      }
      const current: TaskExecutionState = state;
      const newRetryCount: number = current.retryCount + 1;
      state = {
        taskId: current.taskId,
        aggregateVersion: t.aggregateVersion,
        currentAttemptId: t.attemptId,
        retryBudget: current.retryBudget,
        retryCount: newRetryCount,
        retryBackoffMs: current.retryBackoffMs,
        retryEligibleAt: null, // backoff set on next failure
      };

      const newOrdinal = attempts.length + 1;
      attempts.push({
        attemptId: t.attemptId,
        taskId: t.taskId,
        ordinal: newOrdinal,
        status: 'issued' as const,
        issuedAt: t.recordedAt,
        startedAt: null,
        completedAt: null,
      });
      attemptIndex.set(t.attemptId, 'issued');
      issuedAttempts.add(t.attemptId);
    } else {
      // Validate: attempt must have been issued
      if (!issuedAttempts.has(t.attemptId)) {
        throw new Error(
          `Replay invariant violation at version ${t.aggregateVersion}: ` +
            `attempt ${t.attemptId} references an unissued attempt`,
        );
      }

      const currentStatus = attemptIndex.get(t.attemptId);
      const targetStatus = EVENT_TO_ATTEMPT_STATUS[t.eventType];
      if (!targetStatus) {
        throw new Error(
          `Replay invariant violation: unknown event type ${t.eventType}`,
        );
      }

      // Validate the lifecycle edge
      // The attempt being transitioned must be the current attempt — an old
      // failed attempt cannot transition after a retry has superseded it.
      if (state !== null && t.attemptId !== state.currentAttemptId) {
        throw new Error(
          `Replay invariant violation at version ${t.aggregateVersion}: ` +
            `attempt ${t.attemptId} is not the current attempt ` +
            `(${state.currentAttemptId})`,
        );
      }

      if (
        currentStatus !== undefined &&
        !isValidAttemptTransition(currentStatus, targetStatus)
      ) {
        throw new Error(
          `Replay invariant violation at version ${t.aggregateVersion}: ` +
            `invalid attempt transition ${currentStatus} → ${targetStatus} ` +
            `for attempt ${t.attemptId}`,
        );
      }

      // Update state
      if (state === null) {
        throw new Error(
          `Replay invariant violation: transition before issuance for task ${t.taskId}`,
        );
      }

      state = {
        taskId: state.taskId,
        aggregateVersion: t.aggregateVersion,
        currentAttemptId: clearsCurrentAttempt(targetStatus)
          ? null
          : state.currentAttemptId,
        retryBudget: state.retryBudget,
        retryCount: state.retryCount,
        retryBackoffMs: state.retryBackoffMs,
        retryEligibleAt:
          targetStatus === 'failed'
            ? computeRetryEligibleAt(
                t.recordedAt,
                state.retryBackoffMs,
                state.retryCount,
              )
            : state.retryEligibleAt,
      };

      // Update the attempt
      const attempt = attempts.find(
        (a) => a.attemptId === t.attemptId,
      );
      if (attempt !== undefined) {
        if (targetStatus === 'running' && attempt.startedAt === null) {
          attempt.startedAt = t.recordedAt;
        }
        attempt.status = targetStatus;
        // All three terminal statuses set completedAt
        if (
          targetStatus === 'succeeded' ||
          targetStatus === 'failed' ||
          targetStatus === 'cancelled'
        ) {
          attempt.completedAt = t.recordedAt;
        }
      }
      attemptIndex.set(t.attemptId, targetStatus);
    }
  }

  return { state, attempts };
}

function buildInitialState(t: TaskExecutionTransition): TaskExecutionState {
  const payload = t.transitionPayload as Record<string, unknown>;

  const rb = payload.retryBudget;
  if (
    typeof rb !== 'number' ||
    !Number.isSafeInteger(rb) ||
    rb < 0 ||
    rb > MAX_RETRY_BUDGET
  ) {
    throw new Error(
      `Replay invariant violation at version ${t.aggregateVersion}: ` +
        `missing or invalid retryBudget (${JSON.stringify(rb)}) in initial issuance payload`,
    );
  }

  const bm = payload.retryBackoffMs;
  if (
    typeof bm !== 'number' ||
    !Number.isSafeInteger(bm) ||
    bm < 0 ||
    bm > MAX_RETRY_BACKOFF_MS
  ) {
    throw new Error(
      `Replay invariant violation at version ${t.aggregateVersion}: ` +
        `missing or invalid retryBackoffMs (${JSON.stringify(bm)}) in initial issuance payload`,
    );
  }

  return {
    taskId: t.taskId,
    aggregateVersion: t.aggregateVersion,
    currentAttemptId: t.attemptId,
    retryBudget: rb,
    retryCount: 0,
    retryBackoffMs: bm,
    retryEligibleAt: null,
  };
}

/**
 * Compute a deterministic SHA-256 hash of the decision-bearing state fields
 * for replay byte-equivalence comparison.
 */
export function decisionHash(
  state: TaskExecutionState | null,
  attempts: TaskExecutionAttempt[],
): string {
  const decisionState = {
    taskId: state?.taskId ?? null,
    aggregateVersion: state?.aggregateVersion ?? 0,
    currentAttemptId: state?.currentAttemptId ?? null,
    retryBudget: state?.retryBudget ?? 0,
    retryCount: state?.retryCount ?? 0,
    retryBackoffMs: state?.retryBackoffMs ?? 0,
    retryEligibleAt:
      state?.retryEligibleAt instanceof Date
        ? state.retryEligibleAt.toISOString()
        : null,
    attempts: attempts.map((a) => ({
      attemptId: a.attemptId,
      taskId: a.taskId,
      ordinal: a.ordinal,
      status: a.status,
      issuedAt: a.issuedAt instanceof Date ? a.issuedAt.toISOString() : null,
      startedAt: a.startedAt instanceof Date ? a.startedAt.toISOString() : null,
      completedAt: a.completedAt instanceof Date ? a.completedAt.toISOString() : null,
    })),
  };
  const json = canonicalJson(decisionState);
  return createHash('sha256').update(json, 'utf8').digest('hex');
}

function computeRetryEligibleAt(
  recordedAt: Date,
  retryBackoffMs: number,
  retryCount: number,
): Date | null {
  if (retryBackoffMs <= 0) return null;
  const delay = retryBackoffMs * Math.pow(2, Math.max(0, retryCount));
  const capped = Math.min(delay, MAX_RETRY_BACKOFF_MS);
  return new Date(recordedAt.getTime() + capped);
}
