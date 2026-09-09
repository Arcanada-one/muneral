// MUN-0040: unit tests for TaskExecutionRecorderService — the piece that
// turns a Task.status transition into MUN-0020 execution-authority commands.
// ExecutionAuthorityService.executeCommand is mocked; these tests verify the
// recorder picks the right command for each state, and stays best-effort
// (never throws) exactly as its own contract promises.

import { TaskExecutionRecorderService } from '../src/execution-authority/task-execution-recorder.service';
import { ExecutionAuthorityService } from '../src/execution-authority/execution-authority.service';
import { StaleVersionError } from '../src/execution-authority/execution-authority.errors';

const makePrisma = () => ({
  taskExecutionState: { findUnique: jest.fn() },
  taskExecutionAttempt: { findUnique: jest.fn() },
});

const makeAuthority = () => ({
  executeCommand: jest.fn(),
});

describe('TaskExecutionRecorderService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let authority: ReturnType<typeof makeAuthority>;
  let recorder: TaskExecutionRecorderService;

  beforeEach(() => {
    prisma = makePrisma();
    authority = makeAuthority();
    recorder = new TaskExecutionRecorderService(
      prisma as never,
      authority as unknown as ExecutionAuthorityService,
    );
  });

  describe('entering in_progress', () => {
    it('issues and starts an initial attempt when no state exists', async () => {
      prisma.taskExecutionState.findUnique.mockResolvedValue(null);
      authority.executeCommand
        .mockResolvedValueOnce({
          state: { currentAttemptId: 'att-1', aggregateVersion: 1 },
        })
        .mockResolvedValueOnce({
          state: { currentAttemptId: 'att-1', aggregateVersion: 2 },
        });

      const outcome = await recorder.onStatusTransition('task-1', 'in_progress', 'corr-1');

      expect(outcome.verdict).toBe('recorded');
      expect(authority.executeCommand).toHaveBeenCalledTimes(2);
      expect(authority.executeCommand.mock.calls[0][1]).toMatchObject({
        kind: 'issue_initial_attempt',
        taskId: 'task-1',
        expectedVersion: 0,
      });
      expect(authority.executeCommand.mock.calls[1][1]).toMatchObject({
        kind: 'transition_attempt',
        attemptId: 'att-1',
        eventType: 'attempt:started',
        expectedVersion: 1,
      });
    });

    it('is not_measured when the prior episode already reached a terminal state', async () => {
      prisma.taskExecutionState.findUnique.mockResolvedValue({
        taskId: 'task-1',
        aggregateVersion: 5n,
        currentAttemptId: null,
        retryCount: 0,
        retryEligibleAt: null,
      });

      const outcome = await recorder.onStatusTransition('task-1', 'in_progress', 'corr-1');

      expect(outcome.verdict).toBe('skipped');
      expect(outcome.reason).toMatch(/terminal execution episode/);
      expect(authority.executeCommand).not.toHaveBeenCalled();
    });

    it('is idempotent when the current attempt is already running', async () => {
      prisma.taskExecutionState.findUnique.mockResolvedValue({
        taskId: 'task-1',
        aggregateVersion: 2n,
        currentAttemptId: 'att-1',
        retryCount: 0,
        retryEligibleAt: null,
      });
      prisma.taskExecutionAttempt.findUnique.mockResolvedValue({
        attemptId: 'att-1',
        status: 'running',
      });

      const outcome = await recorder.onStatusTransition('task-1', 'in_progress', 'corr-1');

      expect(outcome).toEqual({ verdict: 'skipped', reason: 'attempt already running' });
      expect(authority.executeCommand).not.toHaveBeenCalled();
    });

    it('starts an issued attempt that was never started', async () => {
      prisma.taskExecutionState.findUnique.mockResolvedValue({
        taskId: 'task-1',
        aggregateVersion: 1n,
        currentAttemptId: 'att-1',
        retryCount: 0,
        retryEligibleAt: null,
      });
      prisma.taskExecutionAttempt.findUnique.mockResolvedValue({
        attemptId: 'att-1',
        status: 'issued',
      });
      authority.executeCommand.mockResolvedValue({
        state: { currentAttemptId: 'att-1', aggregateVersion: 2 },
      });

      const outcome = await recorder.onStatusTransition('task-1', 'in_progress', 'corr-1');

      expect(outcome.verdict).toBe('recorded');
      expect(authority.executeCommand).toHaveBeenCalledTimes(1);
      expect(authority.executeCommand.mock.calls[0][1]).toMatchObject({
        kind: 'transition_attempt',
        eventType: 'attempt:started',
        expectedVersion: 1,
      });
    });

    it('issues a retry when the current attempt failed and backoff has elapsed', async () => {
      prisma.taskExecutionState.findUnique.mockResolvedValue({
        taskId: 'task-1',
        aggregateVersion: 3n,
        currentAttemptId: 'att-1',
        retryCount: 1n,
        retryEligibleAt: new Date('2020-01-01T00:00:00Z'),
      });
      prisma.taskExecutionAttempt.findUnique.mockResolvedValue({
        attemptId: 'att-1',
        status: 'failed',
      });
      authority.executeCommand
        .mockResolvedValueOnce({ state: { currentAttemptId: 'att-2', aggregateVersion: 4 } })
        .mockResolvedValueOnce({ state: { currentAttemptId: 'att-2', aggregateVersion: 5 } });

      const outcome = await recorder.onStatusTransition('task-1', 'in_progress', 'corr-1');

      expect(outcome.verdict).toBe('recorded');
      expect(authority.executeCommand.mock.calls[0][1]).toMatchObject({
        kind: 'issue_retry_attempt',
        expectedVersion: 3,
      });
      expect(authority.executeCommand.mock.calls[1][1]).toMatchObject({
        kind: 'transition_attempt',
        attemptId: 'att-2',
        eventType: 'attempt:started',
      });
    });

    it('skips the retry while the backoff window is still open', async () => {
      prisma.taskExecutionState.findUnique.mockResolvedValue({
        taskId: 'task-1',
        aggregateVersion: 3n,
        currentAttemptId: 'att-1',
        retryCount: 1n,
        retryEligibleAt: new Date(Date.now() + 3_600_000),
      });
      prisma.taskExecutionAttempt.findUnique.mockResolvedValue({
        attemptId: 'att-1',
        status: 'failed',
      });

      const outcome = await recorder.onStatusTransition('task-1', 'in_progress', 'corr-1');

      expect(outcome).toEqual({
        verdict: 'skipped',
        reason: 'retry not yet eligible (backoff window open)',
      });
      expect(authority.executeCommand).not.toHaveBeenCalled();
    });
  });

  describe('leaving in_progress to a terminal task status', () => {
    it('marks the running attempt succeeded on done', async () => {
      prisma.taskExecutionState.findUnique.mockResolvedValue({
        taskId: 'task-1',
        aggregateVersion: 2n,
        currentAttemptId: 'att-1',
      });
      prisma.taskExecutionAttempt.findUnique.mockResolvedValue({
        attemptId: 'att-1',
        status: 'running',
      });
      authority.executeCommand.mockResolvedValue({ state: {} });

      const outcome = await recorder.onStatusTransition('task-1', 'done', 'corr-1');

      expect(outcome.verdict).toBe('recorded');
      expect(authority.executeCommand.mock.calls[0][1]).toMatchObject({
        kind: 'transition_attempt',
        eventType: 'attempt:succeeded',
        expectedVersion: 2,
      });
    });

    it('marks the running attempt cancelled on cancelled', async () => {
      prisma.taskExecutionState.findUnique.mockResolvedValue({
        taskId: 'task-1',
        aggregateVersion: 2n,
        currentAttemptId: 'att-1',
      });
      prisma.taskExecutionAttempt.findUnique.mockResolvedValue({
        attemptId: 'att-1',
        status: 'running',
      });
      authority.executeCommand.mockResolvedValue({ state: {} });

      const outcome = await recorder.onStatusTransition('task-1', 'cancelled', 'corr-1');

      expect(authority.executeCommand.mock.calls[0][1]).toMatchObject({
        eventType: 'attempt:cancelled',
      });
      expect(outcome.verdict).toBe('recorded');
    });

    it('is a no-op when there is no execution state to close', async () => {
      prisma.taskExecutionState.findUnique.mockResolvedValue(null);

      const outcome = await recorder.onStatusTransition('task-1', 'done', 'corr-1');

      expect(outcome).toEqual({
        verdict: 'skipped',
        reason: 'no running execution attempt to close',
      });
      expect(authority.executeCommand).not.toHaveBeenCalled();
    });
  });

  it('takes no execution-authority action for transitions that are neither entry nor exit', async () => {
    const outcome = await recorder.onStatusTransition('task-1', 'review', 'corr-1');

    expect(outcome).toEqual({
      verdict: 'skipped',
      reason: 'no execution-authority action for transition to review',
    });
    expect(prisma.taskExecutionState.findUnique).not.toHaveBeenCalled();
  });

  describe('failure handling — never throws', () => {
    it('reports failed when executeCommand returns a typed error', async () => {
      prisma.taskExecutionState.findUnique.mockResolvedValue(null);
      authority.executeCommand.mockResolvedValue(
        new StaleVersionError('task-1', 0, 3),
      );

      const outcome = await recorder.onStatusTransition('task-1', 'in_progress', 'corr-1');

      expect(outcome.verdict).toBe('failed');
      expect(outcome.reason).toMatch(/issue_initial_attempt/);
    });

    it('catches a thrown infrastructure error instead of propagating it', async () => {
      prisma.taskExecutionState.findUnique.mockRejectedValue(new Error('connection reset'));

      const outcome = await recorder.onStatusTransition('task-1', 'in_progress', 'corr-1');

      expect(outcome).toEqual({ verdict: 'failed', reason: 'connection reset' });
    });
  });
});
