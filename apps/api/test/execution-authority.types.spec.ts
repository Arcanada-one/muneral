// MUN-0020: Execution authority types — static contract tests.
// Phase 1: Red tests that verify the type system, state machine, and
// discriminated commands before the full implementation is wired.

import {
  ATTEMPT_TRANSITIONS,
  isTerminalAttempt,
  clearsCurrentAttempt,
  isValidAttemptTransition,
  EVENT_TO_ATTEMPT_STATUS,
} from '../src/execution-authority/execution-authority.types';

describe('Execution authority types', () => {
  describe('ATTEMPT_TRANSITIONS (attempt status machine)', () => {
    it('allows issued → running, failed, cancelled', () => {
      expect(isValidAttemptTransition('issued', 'running')).toBe(true);
      expect(isValidAttemptTransition('issued', 'failed')).toBe(true);
      expect(isValidAttemptTransition('issued', 'cancelled')).toBe(true);
    });

    it('allows running → succeeded, failed, cancelled', () => {
      expect(isValidAttemptTransition('running', 'succeeded')).toBe(true);
      expect(isValidAttemptTransition('running', 'failed')).toBe(true);
      expect(isValidAttemptTransition('running', 'cancelled')).toBe(true);
    });

    it('disallows illegal transitions', () => {
      expect(isValidAttemptTransition('issued', 'succeeded')).toBe(false);
      expect(isValidAttemptTransition('succeeded', 'failed')).toBe(false);
      expect(isValidAttemptTransition('cancelled', 'running')).toBe(false);
      expect(isValidAttemptTransition('succeeded', 'running')).toBe(false);
      expect(isValidAttemptTransition('failed', 'succeeded')).toBe(false);
    });

    it('succeeded, failed, and cancelled are terminal', () => {
      expect(isTerminalAttempt('succeeded')).toBe(true);
      expect(isTerminalAttempt('failed')).toBe(true);
      expect(isTerminalAttempt('cancelled')).toBe(true);
      expect(isTerminalAttempt('issued')).toBe(false);
      expect(isTerminalAttempt('running')).toBe(false);
    });

    it('terminal states have no outgoing transitions', () => {
      expect(ATTEMPT_TRANSITIONS['succeeded']).toEqual([]);
      expect(ATTEMPT_TRANSITIONS['failed']).toEqual([]);
      expect(ATTEMPT_TRANSITIONS['cancelled']).toEqual([]);
    });
  });

  describe('clearsCurrentAttempt', () => {
    it('only succeeded and cancelled clear the pointer', () => {
      expect(clearsCurrentAttempt('succeeded')).toBe(true);
      expect(clearsCurrentAttempt('cancelled')).toBe(true);
    });

    it('failed does NOT clear — remains current for retry authorization', () => {
      expect(clearsCurrentAttempt('failed')).toBe(false);
    });

    it('non-terminal states do not clear', () => {
      expect(clearsCurrentAttempt('issued')).toBe(false);
      expect(clearsCurrentAttempt('running')).toBe(false);
    });
  });

  describe('EVENT_TO_ATTEMPT_STATUS', () => {
    it('maps every event type to an attempt status', () => {
      expect(EVENT_TO_ATTEMPT_STATUS['attempt:issued']).toBe('issued');
      expect(EVENT_TO_ATTEMPT_STATUS['attempt:started']).toBe('running');
      expect(EVENT_TO_ATTEMPT_STATUS['attempt:succeeded']).toBe('succeeded');
      expect(EVENT_TO_ATTEMPT_STATUS['attempt:failed']).toBe('failed');
      expect(EVENT_TO_ATTEMPT_STATUS['attempt:cancelled']).toBe('cancelled');
      expect(EVENT_TO_ATTEMPT_STATUS['attempt:retry_issued']).toBe('issued');
    });
  });
});
