import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import {
  TaskFieldStateService,
  TRACKED_FIELDS,
  ACTIVITY_SENTINEL,
  type TaskLike,
} from '../src/tasks/field-state/task-field-state.service';
import { PrismaService } from '../src/prisma/prisma.service';

// ---------------------------------------------------------------------------
// Minimal mock PrismaService — only methods used by TaskFieldStateService
// ---------------------------------------------------------------------------
const makePrisma = () => ({
  taskFieldState: {
    findUnique: jest.fn(),
    create: jest.fn(),
    updateMany: jest.fn(),
    findMany: jest.fn().mockResolvedValue([]),
  },
});

type MockPrisma = ReturnType<typeof makePrisma>;

/** Build a bare-minimum TaskLike with sensible defaults */
function makeTask(overrides: Partial<TaskLike> = {}): TaskLike {
  return {
    id: 'task-1',
    title: 'My Task',
    description: null,
    status: 'todo',
    priority: 'medium',
    dueDate: null,
    estimateHours: null,
    sprintId: null,
    ...overrides,
  };
}

describe('TaskFieldStateService', () => {
  let service: TaskFieldStateService;
  let prisma: MockPrisma;

  beforeEach(async () => {
    prisma = makePrisma();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TaskFieldStateService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<TaskFieldStateService>(TaskFieldStateService);
  });

  // -------------------------------------------------------------------------
  // normalizeFieldValue
  // -------------------------------------------------------------------------
  describe('normalizeFieldValue', () => {
    it('returns empty string for null', () => {
      expect(service.normalizeFieldValue('title', null)).toBe('');
    });

    it('returns empty string for undefined', () => {
      expect(service.normalizeFieldValue('title', undefined)).toBe('');
    });

    it('trims and NFC-normalises string values', () => {
      expect(service.normalizeFieldValue('title', '  Hello  ')).toBe('Hello');
    });

    it('lowercases status enum values', () => {
      expect(service.normalizeFieldValue('status', 'IN_PROGRESS')).toBe(
        'in_progress',
      );
    });

    it('lowercases priority enum values', () => {
      expect(service.normalizeFieldValue('priority', 'HIGH')).toBe('high');
    });

    it('converts Decimal-like objects via toString()', () => {
      const decimal = { toString: () => '1.50', valueOf: () => 1.5 };
      expect(service.normalizeFieldValue('estimateHours', decimal)).toBe(
        '1.50',
      );
    });
  });

  // -------------------------------------------------------------------------
  // sha256
  // -------------------------------------------------------------------------
  describe('sha256', () => {
    it('is deterministic for identical inputs', () => {
      expect(service.sha256('hello')).toBe(service.sha256('hello'));
    });

    it('returns 64-char hex string', () => {
      expect(service.sha256('test')).toMatch(/^[0-9a-f]{64}$/);
    });

    it('returns different digest for different inputs', () => {
      expect(service.sha256('a')).not.toBe(service.sha256('b'));
    });
  });

  // -------------------------------------------------------------------------
  // recompute — operator-required test names (V-AC contract)
  // -------------------------------------------------------------------------
  describe('recompute', () => {
    // V-AC-2: bumps only the changed field version
    it('bumps only the changed field version', async () => {
      const task = makeTask({ title: 'Updated title', status: 'todo' });

      const titleHash = service.sha256(
        service.normalizeFieldValue('title', 'Updated title'),
      );
      const oldTitleHash = service.sha256(
        service.normalizeFieldValue('title', 'Old title'),
      );

      prisma.taskFieldState.findUnique.mockImplementation(
        ({ where }: { where: { taskId_fieldName: { taskId: string; fieldName: string } } }) => {
          const { fieldName } = where.taskId_fieldName;
          if (fieldName === 'title') {
            return Promise.resolve({
              taskId: task.id,
              fieldName: 'title',
              hash: oldTitleHash,
              version: 1n,
            });
          }
          // All other fields: matching hash → no-op
          const rawVal = task[fieldName as keyof TaskLike];
          const matchHash = service.sha256(
            service.normalizeFieldValue(fieldName, rawVal),
          );
          return Promise.resolve({ taskId: task.id, fieldName, hash: matchHash, version: 1n });
        },
      );

      prisma.taskFieldState.updateMany.mockResolvedValue({ count: 1 });

      await service.recompute(prisma as unknown as Prisma.TransactionClient, task);

      // Only title should have been updated
      expect(prisma.taskFieldState.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.taskFieldState.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ fieldName: 'title' }),
          data: expect.objectContaining({ hash: titleHash, version: 2n }),
        }),
      );
    });

    // V-AC-3: tracks every task field after create+update (structural, iterates TRACKED_FIELDS)
    it('tracks every task field after create+update', async () => {
      // All fields absent → create called for each TRACKED_FIELDS entry
      prisma.taskFieldState.findUnique.mockResolvedValue(null);
      prisma.taskFieldState.create.mockImplementation(
        ({ data }: { data: { taskId: string; fieldName: string; hash: string; version: bigint } }) =>
          Promise.resolve(data),
      );

      const task = makeTask({
        title: 'Hello',
        description: 'World',
        status: 'in_progress',
        priority: 'high',
        dueDate: '2026-12-31',
        estimateHours: 5,
        sprintId: 'sprint-abc',
      });

      await service.recompute(prisma as unknown as Prisma.TransactionClient, task);

      const createdFields = (
        prisma.taskFieldState.create.mock.calls as Array<
          [{ data: { fieldName: string } }]
        >
      ).map((call) => call[0].data.fieldName);

      // Assert every TRACKED_FIELDS entry got a create call
      for (const field of TRACKED_FIELDS) {
        expect(createdFields).toContain(field);
      }
      // Total create count must equal TRACKED_FIELDS length
      expect(prisma.taskFieldState.create).toHaveBeenCalledTimes(
        TRACKED_FIELDS.length,
      );
    });

    // V-AC-7: detects A-B-A via version not hash
    it('detects A-B-A via version not hash', async () => {
      // Real ABA scenario: title was "A" (v1) → "B" (v2) → back to "A" (v3)
      // When evaluating the B→A transition: stored hash=hashB, incoming=hashA → mismatch → bump v2→v3
      const task = makeTask({ title: 'A' });
      const hashA = service.sha256(service.normalizeFieldValue('title', 'A'));
      const hashB = service.sha256(service.normalizeFieldValue('title', 'B'));

      prisma.taskFieldState.findUnique.mockImplementation(
        ({ where }: { where: { taskId_fieldName: { taskId: string; fieldName: string } } }) => {
          const { fieldName } = where.taskId_fieldName;
          if (fieldName === 'title') {
            // Stored state: hash=hashB (was changed to B), version=2
            return Promise.resolve({ taskId: task.id, fieldName: 'title', hash: hashB, version: 2n });
          }
          const rawVal = task[fieldName as keyof TaskLike];
          const matchHash = service.sha256(service.normalizeFieldValue(fieldName, rawVal));
          return Promise.resolve({ taskId: task.id, fieldName, hash: matchHash, version: 1n });
        },
      );

      prisma.taskFieldState.updateMany.mockResolvedValue({ count: 1 });

      // task.title = 'A', stored hash = hashB → hash mismatch → bump to version 3
      await service.recompute(prisma as unknown as Prisma.TransactionClient, task);

      expect(prisma.taskFieldState.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ fieldName: 'title', version: 2n }),
          data: expect.objectContaining({ hash: hashA, version: 3n }),
        }),
      );
    });

    // V-AC-9: field-state recompute is in service layer transaction
    it('field-state recompute is in service layer transaction', async () => {
      // Verify recompute uses the tx argument, not the injected PrismaService.
      const txTaskFieldState = {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(
          ({ data }: { data: unknown }) => Promise.resolve(data),
        ),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      };
      const txMock = {
        taskFieldState: txTaskFieldState,
      } as unknown as Prisma.TransactionClient;

      const task = makeTask();
      await service.recompute(txMock, task);

      // Service must use tx, not the injected PrismaService
      expect(txTaskFieldState.findUnique).toHaveBeenCalled();
      expect(prisma.taskFieldState.findUnique).not.toHaveBeenCalled();
    });

    it('skips write when hash is unchanged (idempotent)', async () => {
      const task = makeTask({ title: 'Same' });

      prisma.taskFieldState.findUnique.mockImplementation(
        ({ where }: { where: { taskId_fieldName: { taskId: string; fieldName: string } } }) => {
          const { fieldName } = where.taskId_fieldName;
          const rawVal = task[fieldName as keyof TaskLike];
          const matchHash = service.sha256(service.normalizeFieldValue(fieldName, rawVal));
          return Promise.resolve({ taskId: task.id, fieldName, hash: matchHash, version: 1n });
        },
      );

      await service.recompute(prisma as unknown as Prisma.TransactionClient, task);

      expect(prisma.taskFieldState.create).not.toHaveBeenCalled();
      expect(prisma.taskFieldState.updateMany).not.toHaveBeenCalled();
    });

    it('retries on optimistic lock miss (count===0) and succeeds', async () => {
      const task = makeTask({ title: 'New' });
      const oldHash = service.sha256(service.normalizeFieldValue('title', 'Old'));

      let updateCall = 0;
      prisma.taskFieldState.findUnique.mockImplementation(
        ({ where }: { where: { taskId_fieldName: { taskId: string; fieldName: string } } }) => {
          const { fieldName } = where.taskId_fieldName;
          if (fieldName === 'title') {
            return Promise.resolve({
              taskId: task.id,
              fieldName: 'title',
              hash: oldHash,
              version: BigInt(1 + updateCall),
            });
          }
          const rawVal = task[fieldName as keyof TaskLike];
          const mh = service.sha256(service.normalizeFieldValue(fieldName, rawVal));
          return Promise.resolve({ taskId: task.id, fieldName, hash: mh, version: 1n });
        },
      );

      prisma.taskFieldState.updateMany.mockImplementation(
        ({ where }: { where: { fieldName: string } }) => {
          if (where.fieldName === 'title') {
            updateCall++;
            if (updateCall < 2) return Promise.resolve({ count: 0 }); // first miss
          }
          return Promise.resolve({ count: 1 });
        },
      );

      await service.recompute(prisma as unknown as Prisma.TransactionClient, task);

      const titleCalls = (
        prisma.taskFieldState.updateMany.mock.calls as Array<
          [{ where: { fieldName: string } }]
        >
      ).filter((call) => call[0].where.fieldName === 'title');
      expect(titleCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  // -------------------------------------------------------------------------
  // TRACKED_FIELDS const
  // -------------------------------------------------------------------------
  describe('TRACKED_FIELDS', () => {
    it('contains exactly the 7 required field names', () => {
      expect(TRACKED_FIELDS).toEqual(
        expect.arrayContaining([
          'title',
          'description',
          'status',
          'priority',
          'dueDate',
          'estimateHours',
          'sprintId',
        ]),
      );
      expect(TRACKED_FIELDS).toHaveLength(7);
    });

    it('does not include the activity sentinel', () => {
      expect(TRACKED_FIELDS).not.toContain(ACTIVITY_SENTINEL);
    });
  });
});
