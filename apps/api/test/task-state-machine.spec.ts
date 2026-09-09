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
      // MUN-0043: archiving files a settled card away, and unarchiving puts it
      // back on the board without a completion claim.
      ['done', 'archived'],
      ['cancelled', 'archived'],
      ['archived', 'todo'],
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
      // MUN-0043: `archived` is not a back door onto the working statuses, and
      // it is not reachable from live work — abandoning live work is
      // `cancelled`. Above all it is not interchangeable with `done`: an
      // archive step says the card left the board, never that it was finished.
      ['todo', 'archived'],
      ['in_progress', 'archived'],
      ['review', 'archived'],
      ['blocked', 'archived'],
      ['archived', 'done'],
      ['archived', 'in_progress'],
      ['archived', 'review'],
      ['archived', 'blocked'],
      ['archived', 'cancelled'],
      ['archived', 'archived'],
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
      'todo', 'in_progress', 'review', 'blocked', 'done', 'cancelled', 'archived',
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

    // The map is typed `Record<TaskStatus, TaskStatus[]>`, so a status added to
    // the union without an entry is a compile error — but a status added to the
    // union and left out of `allStatuses` here would silently go untested. This
    // pins the list to the map's own keys.
    it('covers exactly the statuses the map declares', () => {
      expect(Object.keys(TASK_TRANSITIONS).sort()).toEqual([...allStatuses].sort());
    });
  });
});
