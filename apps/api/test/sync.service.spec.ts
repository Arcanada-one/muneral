import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { SyncService } from '../src/sync/sync.service';
import { Task } from '../src/tasks/entities/task.entity';
import { Project } from '../src/projects/entities/project.entity';

const makeProjectRepo = () => ({
  findOne: jest.fn(),
});

const makeTaskRepo = () => ({
  createQueryBuilder: jest.fn().mockReturnValue({
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
  }),
  findOne: jest.fn(),
  create: jest.fn((data) => ({ id: 'task-new', ...data })),
  save: jest.fn((entity) => Promise.resolve(entity)),
});

const MOCK_PROJECT: Partial<Project> = {
  id: 'proj-1',
  name: 'Muneral Core',
  workspaceId: 'ws-1',
};

describe('SyncService', () => {
  let service: SyncService;
  let projectRepo: ReturnType<typeof makeProjectRepo>;
  let taskRepo: ReturnType<typeof makeTaskRepo>;

  beforeEach(async () => {
    projectRepo = makeProjectRepo();
    taskRepo = makeTaskRepo();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SyncService,
        { provide: getRepositoryToken(Task), useValue: taskRepo },
        { provide: getRepositoryToken(Project), useValue: projectRepo },
      ],
    }).compile();

    service = module.get<SyncService>(SyncService);
  });

  describe('exportDatarim', () => {
    it('throws NotFoundException for unknown project', async () => {
      projectRepo.findOne.mockResolvedValue(null);
      await expect(service.exportDatarim('unknown')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('generates correct Datarim markdown header', async () => {
      projectRepo.findOne.mockResolvedValue(MOCK_PROJECT);

      const output = await service.exportDatarim('proj-1');
      expect(output).toMatch(/^# Tasks — Muneral Core/);
      expect(output).toMatch(/Last Updated: \d{4}-\d{2}-\d{2}/);
      expect(output).toContain('## Active Tasks');
    });

    it('separates active and done tasks correctly', async () => {
      projectRepo.findOne.mockResolvedValue(MOCK_PROJECT);

      const mockTasks: Partial<Task>[] = [
        { id: 'aaaa-1234', title: 'Active task', status: 'in_progress', priority: 'high', actorType: 'human' },
        { id: 'bbbb-5678', title: 'Done task', status: 'done', priority: 'medium', actorType: 'agent' },
      ];
      taskRepo.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(mockTasks),
      });

      const output = await service.exportDatarim('proj-1');
      expect(output).toContain('## Active Tasks');
      expect(output).toContain('Active task');
      expect(output).toContain('## Completed Tasks');
      expect(output).toContain('Done task');
    });

    it('includes task metadata fields', async () => {
      projectRepo.findOne.mockResolvedValue(MOCK_PROJECT);

      const mockTasks: Partial<Task>[] = [
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
      taskRepo.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(mockTasks),
      });

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
      projectRepo.findOne.mockResolvedValue(null);
      await expect(
        service.importDatarim('unknown', '# Tasks'),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException for empty markdown', async () => {
      projectRepo.findOne.mockResolvedValue(MOCK_PROJECT);
      await expect(service.importDatarim('proj-1', '')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('creates new tasks from parsed markdown', async () => {
      projectRepo.findOne.mockResolvedValue(MOCK_PROJECT);
      taskRepo.findOne.mockResolvedValue(null); // no existing tasks

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
      expect(taskRepo.save).toHaveBeenCalledTimes(2);
    });

    it('updates existing tasks when title matches', async () => {
      projectRepo.findOne.mockResolvedValue(MOCK_PROJECT);
      const existingTask = {
        id: 'task-existing',
        title: 'Fix critical bug',
        status: 'todo',
        priority: 'low',
      };
      taskRepo.findOne.mockResolvedValue(existingTask);
      taskRepo.save.mockResolvedValue(existingTask);

      const markdown = `
### MUN-AAAA: Fix critical bug
- **Status:** in_progress
- **Priority:** high
`;

      const result = await service.importDatarim('proj-1', markdown);
      expect(result.updated).toBe(1);
      expect(result.created).toBe(0);
      expect(existingTask.status).toBe('in_progress');
      expect(existingTask.priority).toBe('high');
    });

    it('ignores invalid status values', async () => {
      projectRepo.findOne.mockResolvedValue(MOCK_PROJECT);
      taskRepo.findOne.mockResolvedValue(null);

      const markdown = `
### Invalid status task
- **Status:** invalid_status
- **Priority:** medium
`;

      const result = await service.importDatarim('proj-1', markdown);
      expect(result.created).toBe(1);
      // Should default to 'todo' since invalid_status is not valid
      const createCall = (taskRepo.create as jest.Mock).mock.calls[0][0];
      expect(createCall.status).toBe('todo');
    });
  });
});
