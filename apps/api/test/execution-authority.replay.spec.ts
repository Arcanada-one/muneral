// MUN-0020: Deterministic replay tests — rebuild from transition facts.

import { replayJournal, decisionHash } from '../src/execution-authority/execution-authority.replay';
import type { TaskExecutionTransition } from '../src/execution-authority/execution-authority.types';

const BASE_TIME = new Date('2026-07-30T12:00:00Z');

function makeTransition(
  overrides: Partial<TaskExecutionTransition> & {
    taskId: string;
    aggregateVersion: number;
    eventType: TaskExecutionTransition['eventType'];
    attemptId: string;
    idempotencyKey: string;
  },
): TaskExecutionTransition {
  const {
    taskId,
    attemptId,
    aggregateVersion,
    eventType,
    idempotencyKey,
    ...restOverrides
  } = overrides;
  return {
    id: `tx-${aggregateVersion}`,
    taskId,
    attemptId,
    aggregateVersion,
    eventType,
    idempotencyKey,
    commandDigest: 'sha256-test',
    transitionPayload:
      eventType === 'attempt:issued'
        ? { retryBudget: 3, retryBackoffMs: 1000 }
        : {},
    committedResult: {},
    evidenceRefs: [],
    causationId: 'cause-1',
    correlationId: 'corr-1',
    recordedAt: new Date(
      BASE_TIME.getTime() + aggregateVersion * 1000,
    ),
    ...restOverrides,
  };
}

describe('replayJournal', () => {
  it('returns null state for empty journal', () => {
    const { state, attempts } = replayJournal([]);
    expect(state).toBeNull();
    expect(attempts).toEqual([]);
  });

  it('reconstructs initial attempt issuance', () => {
    const transitions = [
      makeTransition({
        taskId: 'task-1',
        attemptId: 'att-1',
        aggregateVersion: 1,
        eventType: 'attempt:issued',
        idempotencyKey: 'idem-1',
      }),
    ];

    const { state, attempts } = replayJournal(transitions);

    expect(state).not.toBeNull();
    expect(state!.taskId).toBe('task-1');
    expect(state!.aggregateVersion).toBe(1);
    expect(state!.currentAttemptId).toBe('att-1');
    expect(state!.retryCount).toBe(0);

    expect(attempts).toHaveLength(1);
    expect(attempts[0].attemptId).toBe('att-1');
    expect(attempts[0].ordinal).toBe(1);
    expect(attempts[0].status).toBe('issued');
  });

  it('reconstructs a full life-cycle: issue → start → succeed', () => {
    const transitions = [
      makeTransition({
        taskId: 'task-1',
        attemptId: 'att-1',
        aggregateVersion: 1,
        eventType: 'attempt:issued',
        idempotencyKey: 'idem-1',
      }),
      makeTransition({
        taskId: 'task-1',
        attemptId: 'att-1',
        aggregateVersion: 2,
        eventType: 'attempt:started',
        idempotencyKey: 'idem-2',
      }),
      makeTransition({
        taskId: 'task-1',
        attemptId: 'att-1',
        aggregateVersion: 3,
        eventType: 'attempt:succeeded',
        idempotencyKey: 'idem-3',
        committedResult: { ok: true },
      }),
    ];

    const { state, attempts } = replayJournal(transitions);

    expect(state).not.toBeNull();
    expect(state!.aggregateVersion).toBe(3);
    expect(state!.currentAttemptId).toBeNull(); // terminal

    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe('succeeded');
    expect(attempts[0].completedAt).not.toBeNull();
  });

  it('reconstructs retry after failure', () => {
    // att-1 failed at 12:00:02 → eligible at 12:00:03 (1000 * 2^0)
    // retry at 12:00:04 > 12:00:03 ✓
    const transitions = [
      makeTransition({
        taskId: 'task-1', attemptId: 'att-1', aggregateVersion: 1,
        eventType: 'attempt:issued', idempotencyKey: 'idem-1',
      }),
      makeTransition({
        taskId: 'task-1', attemptId: 'att-1', aggregateVersion: 2,
        eventType: 'attempt:failed', idempotencyKey: 'idem-2',
        recordedAt: new Date(BASE_TIME.getTime() + 2000),
      }),
      makeTransition({
        taskId: 'task-1', attemptId: 'att-2', aggregateVersion: 3,
        eventType: 'attempt:retry_issued', idempotencyKey: 'idem-3',
        recordedAt: new Date(BASE_TIME.getTime() + 4000),
      }),
    ];

    const { state, attempts } = replayJournal(transitions);

    expect(state).not.toBeNull();
    expect(state!.aggregateVersion).toBe(3);
    expect(state!.currentAttemptId).toBe('att-2');
    expect(state!.retryCount).toBe(1);

    expect(attempts).toHaveLength(2);
    expect(attempts[0].attemptId).toBe('att-1');
    expect(attempts[0].ordinal).toBe(1);
    expect(attempts[0].status).toBe('failed');

    expect(attempts[1].attemptId).toBe('att-2');
    expect(attempts[1].ordinal).toBe(2);
    expect(attempts[1].status).toBe('issued');
  });

  it('handles multiple retries', () => {
    // Space timestamps so retry happens after backoff eligibility:
    // att-1 failed at 12:00:02 → eligible at 12:00:03 (1000 * 2^0)
    // retry at 12:00:04 > 12:00:03 ✓
    // att-2 failed at 12:00:05 → eligible at 12:00:07 (1000 * 2^1)
    // retry at 12:00:10 > 12:00:07 ✓
    const transitions = [
      makeTransition({
        taskId: 'task-1', attemptId: 'att-1', aggregateVersion: 1,
        eventType: 'attempt:issued', idempotencyKey: 'idem-1',
      }),
      makeTransition({
        taskId: 'task-1', attemptId: 'att-1', aggregateVersion: 2,
        eventType: 'attempt:failed', idempotencyKey: 'idem-2',
        recordedAt: new Date(BASE_TIME.getTime() + 2000),
      }),
      makeTransition({
        taskId: 'task-1', attemptId: 'att-2', aggregateVersion: 3,
        eventType: 'attempt:retry_issued', idempotencyKey: 'idem-3',
        recordedAt: new Date(BASE_TIME.getTime() + 4000),
      }),
      makeTransition({
        taskId: 'task-1', attemptId: 'att-2', aggregateVersion: 4,
        eventType: 'attempt:started', idempotencyKey: 'idem-4',
        recordedAt: new Date(BASE_TIME.getTime() + 4000),
      }),
      makeTransition({
        taskId: 'task-1', attemptId: 'att-2', aggregateVersion: 5,
        eventType: 'attempt:failed', idempotencyKey: 'idem-5',
        recordedAt: new Date(BASE_TIME.getTime() + 5000),
      }),
      makeTransition({
        taskId: 'task-1', attemptId: 'att-3', aggregateVersion: 6,
        eventType: 'attempt:retry_issued', idempotencyKey: 'idem-6',
        recordedAt: new Date(BASE_TIME.getTime() + 10000),
      }),
      makeTransition({
        taskId: 'task-1', attemptId: 'att-3', aggregateVersion: 7,
        eventType: 'attempt:started', idempotencyKey: 'idem-7',
        recordedAt: new Date(BASE_TIME.getTime() + 10000),
      }),
      makeTransition({
        taskId: 'task-1', attemptId: 'att-3', aggregateVersion: 8,
        eventType: 'attempt:succeeded', idempotencyKey: 'idem-8',
        recordedAt: new Date(BASE_TIME.getTime() + 10000),
      }),
    ];

    const { state, attempts } = replayJournal(transitions);

    expect(state).not.toBeNull();
    expect(state!.aggregateVersion).toBe(8);
    expect(state!.currentAttemptId).toBeNull();
    expect(state!.retryCount).toBe(2);

    expect(attempts).toHaveLength(3);
    expect(attempts[0].ordinal).toBe(1);
    expect(attempts[1].ordinal).toBe(2);
    expect(attempts[2].ordinal).toBe(3);
    expect(attempts[2].status).toBe('succeeded');
  });
});

  describe('replayJournal — validation', () => {
    it('rejects version gap', () => {
      const transitions = [
        makeTransition({
          taskId: 'task-1',
          attemptId: 'att-1',
          aggregateVersion: 1,
          eventType: 'attempt:issued',
          idempotencyKey: 'idem-1',
        }),
        // Gap: version 3 instead of 2
        makeTransition({
          taskId: 'task-1',
          attemptId: 'att-1',
          aggregateVersion: 3,
          eventType: 'attempt:started',
          idempotencyKey: 'idem-2',
        }),
      ];
      expect(() => replayJournal(transitions)).toThrow(
        /expected aggregate_version 2/,
      );
    });

    it('rejects out-of-order versions', () => {
      const transitions = [
        makeTransition({
          taskId: 'task-1',
          attemptId: 'att-1',
          aggregateVersion: 2, // starts at 2, not 1
          eventType: 'attempt:issued',
          idempotencyKey: 'idem-1',
        }),
      ];
      expect(() => replayJournal(transitions)).toThrow(
        /expected aggregate_version 1/,
      );
    });

    it('rejects mixed task IDs', () => {
      const transitions = [
        makeTransition({
          taskId: 'task-1',
          attemptId: 'att-1',
          aggregateVersion: 1,
          eventType: 'attempt:issued',
          idempotencyKey: 'idem-1',
        }),
        makeTransition({
          taskId: 'task-2', // different!
          attemptId: 'att-1',
          aggregateVersion: 2,
          eventType: 'attempt:started',
          idempotencyKey: 'idem-2',
        }),
      ];
      expect(() => replayJournal(transitions)).toThrow(/mixed task IDs/);
    });

    it('rejects duplicate initial issuance', () => {
      const transitions = [
        makeTransition({
          taskId: 'task-1',
          attemptId: 'att-1',
          aggregateVersion: 1,
          eventType: 'attempt:issued',
          idempotencyKey: 'idem-1',
        }),
        makeTransition({
          taskId: 'task-1',
          attemptId: 'att-2',
          aggregateVersion: 2,
          eventType: 'attempt:issued', // second issuance
          idempotencyKey: 'idem-2',
        }),
      ];
      expect(() => replayJournal(transitions)).toThrow(
        /duplicate initial issuance/,
      );
    });

    it('rejects missing initial issuance (starts with transition)', () => {
      const transitions = [
        makeTransition({
          taskId: 'task-1',
          attemptId: 'att-1',
          aggregateVersion: 1,
          eventType: 'attempt:started', // not 'attempt:issued'
          idempotencyKey: 'idem-1',
        }),
      ];
      expect(() => replayJournal(transitions)).toThrow(
        /no initial issuance/,
      );
    });

    it('rejects reference to unissued attempt', () => {
      const transitions = [
        makeTransition({
          taskId: 'task-1',
          attemptId: 'att-1',
          aggregateVersion: 1,
          eventType: 'attempt:issued',
          idempotencyKey: 'idem-1',
        }),
        makeTransition({
          taskId: 'task-1',
          attemptId: 'att-2', // never issued
          aggregateVersion: 2,
          eventType: 'attempt:started',
          idempotencyKey: 'idem-2',
        }),
      ];
      expect(() => replayJournal(transitions)).toThrow(
        /unissued attempt/,
      );
    });

    it('rejects invalid lifecycle edge (issued → succeeded without started)', () => {
      const transitions = [
        makeTransition({
          taskId: 'task-1',
          attemptId: 'att-1',
          aggregateVersion: 1,
          eventType: 'attempt:issued',
          idempotencyKey: 'idem-1',
        }),
        makeTransition({
          taskId: 'task-1',
          attemptId: 'att-1',
          aggregateVersion: 2,
          eventType: 'attempt:succeeded', // invalid: issued → succeeded
          idempotencyKey: 'idem-2',
        }),
      ];
      expect(() => replayJournal(transitions)).toThrow(
        /invalid attempt transition issued → succeeded/,
      );
    });

    it('rejects retry_issued when current attempt is not failed', () => {
      const transitions = [
        makeTransition({
          taskId: 'task-1',
          attemptId: 'att-1',
          aggregateVersion: 1,
          eventType: 'attempt:issued',
          idempotencyKey: 'idem-1',
        }),
        makeTransition({
          taskId: 'task-1',
          attemptId: 'att-1',
          aggregateVersion: 2,
          eventType: 'attempt:started',
          idempotencyKey: 'idem-2',
        }),
        makeTransition({
          taskId: 'task-1',
          attemptId: 'att-2',
          aggregateVersion: 3,
          eventType: 'attempt:retry_issued',
          idempotencyKey: 'idem-3',
        }),
      ];
      // att-1 is 'running', not 'failed' — retry should be rejected
      expect(() => replayJournal(transitions)).toThrow(
        /expected failed/,
      );
    });

    it('rejects duplicate attempt IDs on retry', () => {
      const transitions = [
        makeTransition({
          taskId: 'task-1',
          attemptId: 'att-1',
          aggregateVersion: 1,
          eventType: 'attempt:issued',
          idempotencyKey: 'idem-1',
        }),
        makeTransition({
          taskId: 'task-1',
          attemptId: 'att-1',
          aggregateVersion: 2,
          eventType: 'attempt:failed',
          idempotencyKey: 'idem-2',
        }),
        makeTransition({
          taskId: 'task-1',
          attemptId: 'att-1', // reused!
          aggregateVersion: 3,
          eventType: 'attempt:retry_issued',
          idempotencyKey: 'idem-3',
        }),
      ];
      expect(() => replayJournal(transitions)).toThrow(
        /reuses attempt ID/,
      );
    });

    it('rejects initial issuance with missing retryBudget', () => {
      const t = [
        makeTransition({
          taskId: 'task-1', attemptId: 'att-1', aggregateVersion: 1,
          eventType: 'attempt:issued', idempotencyKey: 'idem-1',
          transitionPayload: { retryBackoffMs: 1000 },
        }),
      ];
      expect(() => replayJournal(t)).toThrow(
        /missing or invalid retryBudget/,
      );
    });

    it('rejects initial issuance with negative retryBudget', () => {
      const t = [
        makeTransition({
          taskId: 'task-1', attemptId: 'att-1', aggregateVersion: 1,
          eventType: 'attempt:issued', idempotencyKey: 'idem-1',
          transitionPayload: { retryBudget: -1, retryBackoffMs: 1000 },
        }),
      ];
      expect(() => replayJournal(t)).toThrow(
        /missing or invalid retryBudget/,
      );
    });

    it('rejects initial issuance with non-integer retryBackoffMs', () => {
      const t = [
        makeTransition({
          taskId: 'task-1', attemptId: 'att-1', aggregateVersion: 1,
          eventType: 'attempt:issued', idempotencyKey: 'idem-1',
          transitionPayload: { retryBudget: 3, retryBackoffMs: 1.5 },
        }),
      ];
      expect(() => replayJournal(t)).toThrow(
        /missing or invalid retryBackoffMs/,
      );
    });

    it('rejects retry before eligibility', () => {
      const t = [
        makeTransition({
          taskId: 'task-1', attemptId: 'att-1', aggregateVersion: 1,
          eventType: 'attempt:issued', idempotencyKey: 'idem-1',
        }),
        makeTransition({
          taskId: 'task-1', attemptId: 'att-1', aggregateVersion: 2,
          eventType: 'attempt:failed', idempotencyKey: 'idem-2',
          recordedAt: new Date('2026-07-30T12:01:00Z'),
        }),
        makeTransition({
          taskId: 'task-1', attemptId: 'att-2', aggregateVersion: 3,
          eventType: 'attempt:retry_issued', idempotencyKey: 'idem-3',
          recordedAt: new Date(BASE_TIME.getTime() + 3000),
        }),
      ];
      expect(() => replayJournal(t)).toThrow(/before retryEligibleAt/);
    });

    it('rejects transition on non-current attempt after retry', () => {
      const t = [
        makeTransition({
          taskId: 'task-1', attemptId: 'att-1', aggregateVersion: 1,
          eventType: 'attempt:issued', idempotencyKey: 'idem-1',
        }),
        makeTransition({
          taskId: 'task-1', attemptId: 'att-1', aggregateVersion: 2,
          eventType: 'attempt:failed', idempotencyKey: 'idem-2',
        }),
        makeTransition({
          taskId: 'task-1', attemptId: 'att-2', aggregateVersion: 3,
          eventType: 'attempt:retry_issued', idempotencyKey: 'idem-3',
        }),
        makeTransition({
          taskId: 'task-1', attemptId: 'att-1', aggregateVersion: 4,
          eventType: 'attempt:started', idempotencyKey: 'idem-4',
        }),
      ];
      expect(() => replayJournal(t)).toThrow(
        /is not the current attempt/,
      );
    });
  });

  describe('decisionHash', () => {
  it('produces identical hashes for identical state', () => {
    const t: TaskExecutionTransition[] = [
      makeTransition({
        taskId: 'task-1',
        attemptId: 'att-1',
        aggregateVersion: 1,
        eventType: 'attempt:issued',
        idempotencyKey: 'idem-1',
      }),
    ];

    const { state: s1, attempts: a1 } = replayJournal([...t]);
    const { state: s2, attempts: a2 } = replayJournal([...t]);

    expect(decisionHash(s1, a1)).toBe(decisionHash(s2, a2));
  });

  it('produces different hashes for different task IDs', () => {
    const t1 = [
      makeTransition({
        taskId: 'task-A',
        attemptId: 'att-1',
        aggregateVersion: 1,
        eventType: 'attempt:issued',
        idempotencyKey: 'idem-1',
      }),
    ];
    const t2 = [
      makeTransition({
        taskId: 'task-B',
        attemptId: 'att-1',
        aggregateVersion: 1,
        eventType: 'attempt:issued',
        idempotencyKey: 'idem-1',
      }),
    ];

    const { state: s1, attempts: a1 } = replayJournal(t1);
    const { state: s2, attempts: a2 } = replayJournal(t2);

    expect(decisionHash(s1, a1)).not.toBe(decisionHash(s2, a2));
  });
});
