import { Test, TestingModule } from '@nestjs/testing';
// ESM has no injected globals, so `jest` must be imported for the RUNTIME;
// its type still comes from @types/jest, which every jest.fn() here is
// written against. Same split as the other suites in this directory.
import { jest as _jestRuntime } from '@jest/globals';
const jest = _jestRuntime as unknown as typeof globalThis.jest;
import { TasksService } from '../src/tasks/tasks.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { ActivityService } from '../src/activity/activity.service.js';
import { KanbanService } from '../src/ws/kanban.service.js';
import { TaskFieldStateService } from '../src/tasks/field-state/task-field-state.service.js';
import { TaskExecutionRecorderService } from '../src/execution-authority/task-execution-recorder.service.js';

/**
 * GET /tasks — the filtered query the digest needs.
 *
 * These assert the WHERE clause that reaches Prisma, not just that a call was
 * made: a query endpoint that silently ignores its filters returns the whole
 * table and every caller looks fine until the table grows.
 */
const makePrisma = () => {
  const task = {
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
  };
  return {
    task,
    // $transaction here takes an ARRAY of promises (the batch form), unlike the
    // callback form used by the mutating paths.
    $transaction: jest.fn((ops: unknown[]) => Promise.all(ops as Promise<unknown>[])),
  };
};

describe('TasksService.query', () => {
  let service: TasksService;
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(async () => {
    prisma = makePrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TasksService,
        { provide: PrismaService, useValue: prisma },
        { provide: ActivityService, useValue: { log: jest.fn() } },
        { provide: KanbanService, useValue: { notify: jest.fn() } },
        { provide: TaskFieldStateService, useValue: { initialise: jest.fn() } },
        // MUN-0040 added a fifth constructor argument after this suite was
        // written. `query` is a read and never reaches the recorder, so an
        // empty stub is the honest substitute — the same one the other
        // read-side suites use.
        { provide: TaskExecutionRecorderService, useValue: {} },
      ],
    }).compile();
    service = module.get(TasksService);
  });

  const whereOf = () => prisma.task.findMany.mock.calls[0][0].where;
  const argsOf = () => prisma.task.findMany.mock.calls[0][0];

  it('filters by status', async () => {
    await service.query({ status: 'done' });
    expect(whereOf()).toEqual({ status: 'done' });
  });

  it('filters by project', async () => {
    await service.query({ projectId: 'proj-1' });
    expect(whereOf()).toEqual({ projectId: 'proj-1' });
  });

  it('turns updatedSince into a lower bound on updatedAt', async () => {
    await service.query({ updatedSince: '2026-09-08T00:00:00Z' });
    expect(whereOf()).toEqual({
      updatedAt: { gte: new Date('2026-09-08T00:00:00Z') },
    });
  });

  it('combines updatedSince and updatedBefore into one bounded window', async () => {
    await service.query({
      updatedSince: '2026-09-08T00:00:00Z',
      updatedBefore: '2026-09-09T00:00:00Z',
    });
    expect(whereOf()).toEqual({
      updatedAt: {
        gte: new Date('2026-09-08T00:00:00Z'),
        lt: new Date('2026-09-09T00:00:00Z'),
      },
    });
  });

  it('combines status and window — the digest\'s actual question', async () => {
    await service.query({ status: 'done', updatedSince: '2026-09-08T00:00:00Z' });
    expect(whereOf()).toEqual({
      status: 'done',
      updatedAt: { gte: new Date('2026-09-08T00:00:00Z') },
    });
  });

  it('applies a default bound rather than returning the whole table', async () => {
    await service.query({});
    expect(argsOf().take).toBe(50);
    expect(argsOf().skip).toBe(0);
  });

  it('honours an explicit page', async () => {
    await service.query({ limit: 10, offset: 20 });
    expect(argsOf().take).toBe(10);
    expect(argsOf().skip).toBe(20);
  });

  it('orders by updatedAt desc so the most recent movement leads', async () => {
    await service.query({});
    expect(argsOf().orderBy).toEqual({ updatedAt: 'desc' });
  });

  it('counts against the SAME filter it pages — a total from a wider filter would overstate', async () => {
    await service.query({ status: 'done' });
    expect(prisma.task.count).toHaveBeenCalledWith({ where: { status: 'done' } });
  });

  it('reports total beside the page, so an empty page is distinguishable from no matches', async () => {
    prisma.task.findMany.mockResolvedValueOnce([]);
    prisma.task.count.mockResolvedValueOnce(137);
    const res = await service.query({ offset: 1000 });
    expect(res).toEqual({ items: [], total: 137, limit: 50, offset: 1000 });
  });
});

/**
 * Status validation must come from the shared list, not a local copy.
 *
 * The first draft of QueryTasksDto hard-coded six statuses and omitted
 * `archived`, so a query for archived work would have been rejected as
 * invalid — the exact half-applied-addition failure TASK_STATUSES was
 * introduced to end (MUN-0043 found the list copied into three DTOs).
 */
describe('QueryTasksDto status validation', () => {
  it('accepts every status the shared list declares — including archived', async () => {
    const { validate } = await import('class-validator');
    const { plainToInstance } = await import('class-transformer');
    const { QueryTasksDto } = await import('../src/tasks/dto/query-tasks.dto.js');
    const { TASK_STATUSES } = await import('@muneral/types');

    expect(TASK_STATUSES).toContain('archived');

    for (const status of TASK_STATUSES) {
      const errors = await validate(plainToInstance(QueryTasksDto, { status }));
      expect(errors).toHaveLength(0);
    }
  });

  it('still rejects a status the shared list does not declare', async () => {
    const { validate } = await import('class-validator');
    const { plainToInstance } = await import('class-transformer');
    const { QueryTasksDto } = await import('../src/tasks/dto/query-tasks.dto.js');

    const errors = await validate(plainToInstance(QueryTasksDto, { status: 'almost_done' }));
    expect(errors).toHaveLength(1);
  });
});
