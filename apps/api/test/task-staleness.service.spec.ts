// MUN-0040: unit tests for the staleness signal. The point of the card is the
// tri-valued verdict — `not_measured` must never collapse into `healthy` or
// `stalled` for a task this repo has no recorded execution for.

import { TaskStalenessService } from '../src/execution-authority/task-staleness.service';

const makePrisma = () => ({
  task: { findMany: jest.fn() },
  taskExecutionState: { findUnique: jest.fn() },
  taskExecutionAttempt: { findUnique: jest.fn() },
});

const NOW = new Date('2026-09-09T12:00:00Z');
const HOUR = 3_600_000;

describe('TaskStalenessService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let service: TaskStalenessService;

  beforeEach(() => {
    prisma = makePrisma();
    service = new TaskStalenessService(prisma as never);
  });

  describe('evaluateTask', () => {
    it('is not_measured when no TaskExecutionState row exists', async () => {
      prisma.taskExecutionState.findUnique.mockResolvedValue(null);

      const result = await service.evaluateTask('t1', 'critical', 24 * HOUR, NOW);

      expect(result).toEqual({
        taskId: 't1',
        priority: 'critical',
        verdict: 'not_measured',
        ageMs: null,
        reason: 'no recorded execution attempt for this task',
      });
    });

    it('is not_measured when the execution episode already closed (currentAttemptId null)', async () => {
      prisma.taskExecutionState.findUnique.mockResolvedValue({
        taskId: 't1',
        currentAttemptId: null,
      });

      const result = await service.evaluateTask('t1', 'high', 24 * HOUR, NOW);

      expect(result.verdict).toBe('not_measured');
      expect(prisma.taskExecutionAttempt.findUnique).not.toHaveBeenCalled();
    });

    it('is not_measured when the current attempt exists but is not running (e.g. failed, awaiting retry)', async () => {
      prisma.taskExecutionState.findUnique.mockResolvedValue({
        taskId: 't1',
        currentAttemptId: 'att-1',
      });
      prisma.taskExecutionAttempt.findUnique.mockResolvedValue({
        attemptId: 'att-1',
        status: 'failed',
        startedAt: new Date('2026-09-01T00:00:00Z'),
        issuedAt: new Date('2026-09-01T00:00:00Z'),
      });

      const result = await service.evaluateTask('t1', 'high', 24 * HOUR, NOW);

      expect(result.verdict).toBe('not_measured');
      expect(result.reason).toMatch(/status is failed/);
    });

    it('is healthy when the running attempt is younger than the threshold', async () => {
      prisma.taskExecutionState.findUnique.mockResolvedValue({
        taskId: 't1',
        currentAttemptId: 'att-1',
      });
      prisma.taskExecutionAttempt.findUnique.mockResolvedValue({
        attemptId: 'att-1',
        status: 'running',
        startedAt: new Date(NOW.getTime() - 2 * HOUR),
        issuedAt: new Date(NOW.getTime() - 2 * HOUR),
      });

      const result = await service.evaluateTask('t1', 'medium', 24 * HOUR, NOW);

      expect(result.verdict).toBe('healthy');
      expect(result.ageMs).toBe(2 * HOUR);
    });

    it('is stalled when the running attempt is older than the threshold', async () => {
      prisma.taskExecutionState.findUnique.mockResolvedValue({
        taskId: 't1',
        currentAttemptId: 'att-1',
      });
      prisma.taskExecutionAttempt.findUnique.mockResolvedValue({
        attemptId: 'att-1',
        status: 'running',
        startedAt: new Date(NOW.getTime() - 89 * HOUR),
        issuedAt: new Date(NOW.getTime() - 89 * HOUR),
      });

      const result = await service.evaluateTask('t1', 'critical', 24 * HOUR, NOW);

      expect(result.verdict).toBe('stalled');
      expect(result.ageMs).toBe(89 * HOUR);
      expect(result.reason).toMatch(/89h, over the 24h threshold/);
    });

    it('is exactly at the threshold boundary and treats it as healthy (strictly greater-than for stalled)', async () => {
      prisma.taskExecutionState.findUnique.mockResolvedValue({
        taskId: 't1',
        currentAttemptId: 'att-1',
      });
      prisma.taskExecutionAttempt.findUnique.mockResolvedValue({
        attemptId: 'att-1',
        status: 'running',
        startedAt: new Date(NOW.getTime() - 24 * HOUR),
        issuedAt: new Date(NOW.getTime() - 24 * HOUR),
      });

      const result = await service.evaluateTask('t1', 'low', 24 * HOUR, NOW);

      expect(result.verdict).toBe('healthy');
    });

    it('falls back to issuedAt when startedAt is null', async () => {
      prisma.taskExecutionState.findUnique.mockResolvedValue({
        taskId: 't1',
        currentAttemptId: 'att-1',
      });
      prisma.taskExecutionAttempt.findUnique.mockResolvedValue({
        attemptId: 'att-1',
        status: 'running',
        startedAt: null,
        issuedAt: new Date(NOW.getTime() - 5 * HOUR),
      });

      const result = await service.evaluateTask('t1', 'low', 24 * HOUR, NOW);

      expect(result.ageMs).toBe(5 * HOUR);
    });
  });

  describe('reportForProject', () => {
    it('queries only in_progress tasks in the project and evaluates each', async () => {
      prisma.task.findMany.mockResolvedValue([
        { id: 't1', priority: 'critical' },
        { id: 't2', priority: 'high' },
      ]);
      prisma.taskExecutionState.findUnique.mockResolvedValue(null);

      const result = await service.reportForProject('proj-1', 24 * HOUR, undefined, NOW);

      expect(prisma.task.findMany).toHaveBeenCalledWith({
        where: { projectId: 'proj-1', status: 'in_progress' },
        select: { id: true, priority: true },
      });
      expect(result).toHaveLength(2);
      expect(result.every((r) => r.verdict === 'not_measured')).toBe(true);
    });

    it('narrows to the scoped agent, same as findByProject', async () => {
      prisma.task.findMany.mockResolvedValue([]);

      await service.reportForProject('proj-1', 24 * HOUR, 'agent-1', NOW);

      expect(prisma.task.findMany).toHaveBeenCalledWith({
        where: {
          projectId: 'proj-1',
          status: 'in_progress',
          agents: { some: { agentId: 'agent-1' } },
        },
        select: { id: true, priority: true },
      });
    });
  });
});
