import { isValidTransition, TASK_TRANSITIONS, TaskStatus } from '@muneral/types';

describe('Task State Machine', () => {
  describe('isValidTransition', () => {
    const validTransitions: Array<[TaskStatus, TaskStatus]> = [
      ['todo', 'in_progress'],
      ['todo', 'cancelled'],
      ['in_progress', 'review'],
      ['in_progress', 'blocked'],
      ['in_progress', 'todo'],
      ['in_progress', 'cancelled'],
      ['review', 'in_progress'],
      ['review', 'done'],
      ['review', 'blocked'],
      ['blocked', 'in_progress'],
      ['blocked', 'cancelled'],
      ['done', 'in_progress'],
      ['cancelled', 'todo'],
    ];

    test.each(validTransitions)(
      '%s → %s should be VALID',
      (from, to) => {
        expect(isValidTransition(from, to)).toBe(true);
      },
    );

    const invalidTransitions: Array<[TaskStatus, TaskStatus]> = [
      ['todo', 'done'],
      ['todo', 'review'],
      ['todo', 'blocked'],
      ['in_progress', 'done'], // must go through review first
      ['review', 'todo'],
      ['review', 'cancelled'],
      ['blocked', 'done'],
      ['blocked', 'review'],
      ['done', 'cancelled'],
      ['done', 'todo'],
      ['done', 'blocked'],
      ['cancelled', 'in_progress'],
      ['cancelled', 'done'],
    ];

    test.each(invalidTransitions)(
      '%s → %s should be INVALID',
      (from, to) => {
        expect(isValidTransition(from, to)).toBe(false);
      },
    );

    it('returns false for unknown status', () => {
      expect(isValidTransition('unknown' as TaskStatus, 'todo')).toBe(false);
    });
  });

  describe('TASK_TRANSITIONS map completeness', () => {
    const allStatuses: TaskStatus[] = [
      'todo', 'in_progress', 'review', 'blocked', 'done', 'cancelled',
    ];

    it('has an entry for every valid status', () => {
      for (const status of allStatuses) {
        expect(TASK_TRANSITIONS).toHaveProperty(status);
      }
    });

    it('each status transitions to at least one other status', () => {
      for (const status of allStatuses) {
        expect(TASK_TRANSITIONS[status].length).toBeGreaterThan(0);
      }
    });
  });
});
