import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { SyncService } from '../src/sync/sync.service';
import { PrismaService } from '../src/prisma/prisma.service';

const makePrisma = () => ({
  project: {
    findUnique: jest.fn(),
  },
  task: {
    findMany: jest.fn().mockResolvedValue([]),
    findFirst: jest.fn(),
    create: jest.fn((args) => Promise.resolve({ id: 'task-new', ...args.data })),
    update: jest.fn((args) => Promise.resolve({ id: args.where.id, ...args.data })),
  },
});

const MOCK_PROJECT = {
  id: 'proj-1',
  name: 'Muneral Core',
  workspaceId: 'ws-1',
};

describe('SyncService', () => {
  let service: SyncService;
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(async () => {
    prisma = makePrisma();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SyncService,
        { provide: PrismaService, useValue: prisma },
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
    it('throws NotFoundException for unknown project', async () => {
      prisma.project.findUnique.mockResolvedValue(null);
      await expect(
        service.importDatarim('unknown', '# Tasks'),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException for empty markdown', async () => {
      prisma.project.findUnique.mockResolvedValue(MOCK_PROJECT);
      await expect(service.importDatarim('proj-1', '')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('creates new tasks from parsed markdown', async () => {
      prisma.project.findUnique.mockResolvedValue(MOCK_PROJECT);
      prisma.task.findFirst.mockResolvedValue(null); // no existing tasks

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

      const result = await service.importDatarim('proj-1', markdown);
      expect(result.created).toBe(2);
      expect(result.updated).toBe(0);
      expect(prisma.task.create).toHaveBeenCalledTimes(2);
    });

    it('updates existing tasks when title matches', async () => {
      prisma.project.findUnique.mockResolvedValue(MOCK_PROJECT);
      const existingTask = {
        id: 'task-existing',
        title: 'Fix critical bug',
        status: 'todo',
        priority: 'low',
        dueDate: null,
      };
      prisma.task.findFirst.mockResolvedValue(existingTask);
      prisma.task.update.mockResolvedValue({ ...existingTask, status: 'in_progress', priority: 'high' });

      const markdown = `
### MUN-AAAA: Fix critical bug
- **Status:** in_progress
- **Priority:** high
`;

      const result = await service.importDatarim('proj-1', markdown);
      expect(result.updated).toBe(1);
      expect(result.created).toBe(0);
      expect(prisma.task.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'task-existing' },
          data: expect.objectContaining({ status: 'in_progress', priority: 'high' }),
        }),
      );
    });

    it('ignores invalid status values', async () => {
      prisma.project.findUnique.mockResolvedValue(MOCK_PROJECT);
      prisma.task.findFirst.mockResolvedValue(null);

      const markdown = `
### Invalid status task
- **Status:** invalid_status
- **Priority:** medium
`;

      const result = await service.importDatarim('proj-1', markdown);
      expect(result.created).toBe(1);
      // Should default to 'todo' since invalid_status is not valid
      const createCall = (prisma.task.create as jest.Mock).mock.calls[0][0];
      expect(createCall.data.status).toBe('todo');
    });
  });
});
