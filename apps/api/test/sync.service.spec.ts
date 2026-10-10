import { Test, TestingModule } from '@nestjs/testing';
import {
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import type { Actor } from '@muneral/types';
import { SyncService } from '../src/sync/sync.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { TasksService } from '../src/tasks/tasks.service.js';
import { ActivityService } from '../src/activity/activity.service.js';
// ESM has no injected globals, so `jest` must be imported for the RUNTIME.
// Its type, though, comes from @types/jest (already in tsconfig `types`),
// which is what the 339 existing jest.fn() call sites are written against —
// @jest/globals ships a stricter generic whose bare jest.fn() infers `never`
// and would red 416 lines that are not otherwise wrong. Value from one,
// type from the other.
import { jest as _jestRuntime } from '@jest/globals';
const jest = _jestRuntime as unknown as typeof globalThis.jest;

const makePrisma = () => ({
  project: {
    findUnique: jest.fn(),
  },
  agent: {
    findUnique: jest.fn().mockResolvedValue({ workspaceId: 'ws-1' }),
  },
  task: {
    findMany: jest.fn().mockResolvedValue([]),
    findFirst: jest.fn(),
    create: jest.fn((args) => Promise.resolve({ id: 'task-new', ...args.data })),
    update: jest.fn((args) => Promise.resolve({ id: args.where.id, ...args.data })),
  },
});

// A2-379: the import writes only through TasksService — never raw Prisma.
const makeTasks = () => ({
  create: jest.fn((_actor, dto) => Promise.resolve({ id: 'task-new', ...dto })),
  update: jest.fn((id) => Promise.resolve({ id })),
  updateStatus: jest.fn((id) => Promise.resolve({ id })),
});

const makeActivity = () => ({
  log: jest.fn(() => Promise.resolve({})),
});

const AGENT: Actor = { type: 'agent', id: 'agent-1', name: 'importer' };

const MOCK_PROJECT = {
  id: 'proj-1',
  name: 'Muneral Core',
  workspaceId: 'ws-1',
};

describe('SyncService', () => {
  let service: SyncService;
  let prisma: ReturnType<typeof makePrisma>;
  let tasks: ReturnType<typeof makeTasks>;
  let activity: ReturnType<typeof makeActivity>;

  beforeEach(async () => {
    prisma = makePrisma();
    tasks = makeTasks();
    activity = makeActivity();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SyncService,
        { provide: PrismaService, useValue: prisma },
        { provide: TasksService, useValue: tasks },
        { provide: ActivityService, useValue: activity },
      ],
    }).compile();

    service = module.get<SyncService>(SyncService);
  });

  describe('exportDatarim', () => {
    it('throws NotFoundException for unknown project', async () => {
      prisma.project.findUnique.mockResolvedValue(null);
      await expect(service.exportDatarim('unknown')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('generates correct Datarim markdown header', async () => {
      prisma.project.findUnique.mockResolvedValue(MOCK_PROJECT);

      const output = await service.exportDatarim('proj-1');
      expect(output).toMatch(/^# Tasks — Muneral Core/);
      expect(output).toMatch(/Last Updated: \d{4}-\d{2}-\d{2}/);
      expect(output).toContain('## Active Tasks');
    });

    it('separates active and done tasks correctly', async () => {
      prisma.project.findUnique.mockResolvedValue(MOCK_PROJECT);

      const mockTasks = [
        { id: 'aaaa-1234', title: 'Active task', status: 'in_progress', priority: 'high', actorType: 'human' },
        { id: 'bbbb-5678', title: 'Done task', status: 'done', priority: 'medium', actorType: 'agent' },
      ];
      prisma.task.findMany.mockResolvedValue(mockTasks);

      const output = await service.exportDatarim('proj-1');
      expect(output).toContain('## Active Tasks');
      expect(output).toContain('Active task');
      expect(output).toContain('## Completed Tasks');
      expect(output).toContain('Done task');
    });

    // MUN-0043: an archived card is neither active nor completed. It must not
    // be silently dropped from the export either — the round trip would lose it.
    it('gives archived tasks their own section, not the completed one', async () => {
      prisma.project.findUnique.mockResolvedValue(MOCK_PROJECT);

      prisma.task.findMany.mockResolvedValue([
        { id: 'aaaa-1234', title: 'Active task', status: 'in_progress', priority: 'high', actorType: 'human' },
        { id: 'bbbb-5678', title: 'Done task', status: 'done', priority: 'medium', actorType: 'agent' },
        { id: 'cccc-9012', title: 'Archived task', status: 'archived', priority: 'low', actorType: 'human' },
      ]);

      const output = await service.exportDatarim('proj-1');
      expect(output).toContain('## Archived Tasks');
      expect(output).toContain('Archived task');
      expect(output).toContain('**Status:** archived');

      // ...and it is under the archived heading rather than either of the others.
      const archivedSection = output.slice(output.indexOf('## Archived Tasks'));
      expect(archivedSection).toContain('Archived task');
      const beforeArchived = output.slice(0, output.indexOf('## Archived Tasks'));
      expect(beforeArchived).not.toContain('Archived task');
    });

    it('omits the archived section when there is nothing archived', async () => {
      prisma.project.findUnique.mockResolvedValue(MOCK_PROJECT);
      prisma.task.findMany.mockResolvedValue([
        { id: 'aaaa-1234', title: 'Active task', status: 'todo', priority: 'high', actorType: 'human' },
      ]);

      expect(await service.exportDatarim('proj-1')).not.toContain('## Archived Tasks');
    });

    it('includes task metadata fields', async () => {
      prisma.project.findUnique.mockResolvedValue(MOCK_PROJECT);

      const mockTasks = [
        {
          id: 'cccc-abcd',
          title: 'Fix critical bug',
          status: 'in_progress',
          priority: 'critical',
          dueDate: '2026-05-01',
          estimateHours: 4,
          description: 'Need to fix ASAP',
          actorType: 'agent',
        },
      ];
      prisma.task.findMany.mockResolvedValue(mockTasks);

      const output = await service.exportDatarim('proj-1');
      expect(output).toContain('**Status:** in_progress');
      expect(output).toContain('**Priority:** critical');
      expect(output).toContain('**Due:** 2026-05-01');
      expect(output).toContain('**Estimate:** 4h');
      expect(output).toContain('**Description:** Need to fix ASAP');
      expect(output).toContain('**Actor:** agent');
    });
  });

  describe('importDatarim', () => {
    it('refuses anything but an agent actor (A2-379)', async () => {
      prisma.project.findUnique.mockResolvedValue(MOCK_PROJECT);
      await expect(
        service.importDatarim('proj-1', '### x', { type: 'human', id: 'u-1', name: 'u' }),
      ).rejects.toThrow(ForbiddenException);
      await expect(service.importDatarim('proj-1', '### x', undefined)).rejects.toThrow(
        ForbiddenException,
      );
      expect(tasks.create).not.toHaveBeenCalled();
    });

    it('throws NotFoundException for unknown project', async () => {
      prisma.project.findUnique.mockResolvedValue(null);
      await expect(
        service.importDatarim('unknown', '# Tasks', AGENT),
      ).rejects.toThrow(NotFoundException);
    });

    it("answers 404 for a project outside the key agent's workspace, even without the guard", async () => {
      prisma.project.findUnique.mockResolvedValue(MOCK_PROJECT);
      prisma.agent.findUnique.mockResolvedValue({ workspaceId: 'ws-other' });
      await expect(
        service.importDatarim('proj-1', '### only a new title', AGENT),
      ).rejects.toThrow(NotFoundException);
      expect(tasks.create).not.toHaveBeenCalled();
    });

    it('throws BadRequestException for empty markdown', async () => {
      prisma.project.findUnique.mockResolvedValue(MOCK_PROJECT);
      await expect(service.importDatarim('proj-1', '', AGENT)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('creates new tasks through TasksService, as the key agent', async () => {
      prisma.project.findUnique.mockResolvedValue(MOCK_PROJECT);
      prisma.task.findMany.mockResolvedValue([]); // no existing tasks

      const markdown = `
# Tasks — Test
Last Updated: 2026-04-13

## Active Tasks

### MUN-AAAA: Fix critical bug
- **Status:** in_progress
- **Priority:** high
- **Due:** 2026-05-01

### MUN-BBBB: Write tests
- **Status:** todo
- **Priority:** medium
`;

      const result = await service.importDatarim('proj-1', markdown, AGENT);
      expect(result).toEqual({ created: 2, updated: 0, unchanged: 0 });
      expect(tasks.create).toHaveBeenCalledTimes(2);
      expect(tasks.create).toHaveBeenCalledWith(
        AGENT,
        expect.objectContaining({ projectId: 'proj-1', title: 'Fix critical bug', status: 'in_progress' }),
      );
      expect(prisma.task.create).not.toHaveBeenCalled();
    });

    it('moves a matched task through updateStatus when the agent may move it', async () => {
      prisma.project.findUnique.mockResolvedValue(MOCK_PROJECT);
      prisma.task.findMany.mockResolvedValue([
        { id: 'task-existing', status: 'todo', priority: 'low', dueDate: null },
      ]);
      prisma.task.findFirst.mockResolvedValue({ id: 'task-existing' }); // creator or executor

      const markdown = `
### MUN-AAAA: Fix critical bug
- **Status:** in_progress
- **Priority:** high
`;

      const result = await service.importDatarim('proj-1', markdown, AGENT);
      expect(result).toEqual({ created: 0, updated: 1, unchanged: 0 });
      expect(tasks.update).toHaveBeenCalledWith('task-existing', AGENT, { priority: 'high' });
      expect(tasks.updateStatus).toHaveBeenCalledWith('task-existing', AGENT, { status: 'in_progress' });
      expect(prisma.task.update).not.toHaveBeenCalled();
      // The authority query is the 'task-status' rule, inside the workspace.
      const where = (prisma.task.findFirst as jest.Mock).mock.calls[0][0].where;
      expect(where).toMatchObject({ id: 'task-existing', project: { workspaceId: 'ws-1' } });
      expect(where.OR).toEqual([
        { createdById: 'agent-1', actorType: 'agent' },
        { agents: { some: { agentId: 'agent-1', role: 'executor' } } },
      ]);
    });

    it('refuses the whole import when a matched task is not the agent\'s to move', async () => {
      prisma.project.findUnique.mockResolvedValue(MOCK_PROJECT);
      prisma.task.findMany
        .mockResolvedValueOnce([]) // line 1: new
        .mockResolvedValueOnce([{ id: 'task-x', status: 'todo', priority: 'medium', dueDate: null }]);
      prisma.task.findFirst.mockResolvedValue(null);

      await expect(
        service.importDatarim('proj-1', '### new one\n\n### someone else\n- **Status:** done\n', AGENT),
      ).rejects.toThrow(ForbiddenException);
      expect(tasks.create).not.toHaveBeenCalled();
      expect(tasks.updateStatus).not.toHaveBeenCalled();
    });

    it('refuses a move TASK_TRANSITIONS forbids, before writing', async () => {
      prisma.project.findUnique.mockResolvedValue(MOCK_PROJECT);
      prisma.task.findMany.mockResolvedValue([
        { id: 'task-existing', status: 'todo', priority: 'medium', dueDate: null },
      ]);
      prisma.task.findFirst.mockResolvedValue({ id: 'task-existing' });

      await expect(
        service.importDatarim('proj-1', '### t\n- **Status:** done\n', AGENT),
      ).rejects.toThrow(BadRequestException);
      expect(tasks.updateStatus).not.toHaveBeenCalled();
    });

    it('refuses a title that matches more than one task', async () => {
      prisma.project.findUnique.mockResolvedValue(MOCK_PROJECT);
      prisma.task.findMany.mockResolvedValue([
        { id: 'a', status: 'todo', priority: 'medium', dueDate: null },
        { id: 'b', status: 'todo', priority: 'medium', dueDate: null },
      ]);

      await expect(
        service.importDatarim('proj-1', '### dup\n- **Status:** in_progress\n', AGENT),
      ).rejects.toThrow(ConflictException);
      expect(tasks.updateStatus).not.toHaveBeenCalled();
    });

    it('ignores invalid status values', async () => {
      prisma.project.findUnique.mockResolvedValue(MOCK_PROJECT);
      prisma.task.findMany.mockResolvedValue([]);

      const markdown = `
### Invalid status task
- **Status:** invalid_status
- **Priority:** medium
`;

      const result = await service.importDatarim('proj-1', markdown, AGENT);
      expect(result.created).toBe(1);
      // No status is passed, so TasksService.create applies its 'todo' default.
      const [, dto] = (tasks.create as jest.Mock).mock.calls[0];
      expect(dto.status).toBeUndefined();
    });
  });

  // A2-383: one route-level row per import, so the log can say the import ran.
  describe('importDatarim audit row', () => {
    const auditCalls = () =>
      (activity.log as jest.Mock).mock.calls.filter(([o]) => o.action === 'sync:datarim_imported');

    it('names the actor, the project and every change, old -> new', async () => {
      prisma.project.findUnique.mockResolvedValue(MOCK_PROJECT);
      prisma.task.findMany
        .mockResolvedValueOnce([]) // "New one": created
        .mockResolvedValueOnce([{ id: 'task-existing', status: 'todo', priority: 'low', dueDate: null }])
        .mockResolvedValueOnce([{ id: 'task-same', status: 'todo', priority: 'medium', dueDate: null }]);
      prisma.task.findFirst.mockResolvedValue({ id: 'ok' });

      await service.importDatarim(
        'proj-1',
        '### New one\n- **Status:** todo\n\n' +
          '### Existing\n- **Status:** in_progress\n- **Priority:** high\n- **Due:** 2026-10-01\n\n' +
          '### Same\n- **Status:** todo\n',
        AGENT,
      );

      expect(auditCalls()).toHaveLength(1);
      const [opts] = auditCalls()[0];
      expect(opts).toEqual({
        workspaceId: 'ws-1',
        actor: AGENT,
        action: 'sync:datarim_imported',
        payload: {
          projectId: 'proj-1',
          outcome: 'completed',
          created: [{ taskId: 'task-new', title: 'New one', status: 'todo' }],
          updated: [
            {
              taskId: 'task-existing',
              status: { from: 'todo', to: 'in_progress' },
              priority: { from: 'low', to: 'high' },
              dueDate: { from: null, to: '2026-10-01' },
            },
          ],
          unchanged: 1,
        },
      });
    });

    it('records what was applied before a write failed, then rethrows', async () => {
      prisma.project.findUnique.mockResolvedValue(MOCK_PROJECT);
      prisma.task.findMany.mockResolvedValue([]);
      tasks.create
        .mockImplementationOnce((_a, dto) => Promise.resolve({ id: 'first', ...dto }))
        .mockImplementationOnce(() => Promise.reject(new Error('db down')));

      await expect(
        service.importDatarim('proj-1', '### one\n- **Status:** todo\n\n### two\n', AGENT),
      ).rejects.toThrow('db down');

      expect(auditCalls()).toHaveLength(1);
      expect(auditCalls()[0][0].payload).toMatchObject({
        outcome: 'failed',
        error: 'db down',
        created: [{ taskId: 'first', title: 'one', status: 'todo' }],
        updated: [],
      });
    });

    it('writes no audit row when the import is refused before any write', async () => {
      prisma.project.findUnique.mockResolvedValue(MOCK_PROJECT);
      prisma.task.findMany.mockResolvedValue([
        { id: 'a', status: 'todo', priority: 'medium', dueDate: null },
        { id: 'b', status: 'todo', priority: 'medium', dueDate: null },
      ]);

      await expect(service.importDatarim('proj-1', '### dup\n', AGENT)).rejects.toThrow(ConflictException);
      expect(activity.log).not.toHaveBeenCalled();
    });
  });
});
