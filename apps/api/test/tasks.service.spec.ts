import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TasksService } from '../src/tasks/tasks.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { ActivityService } from '../src/activity/activity.service';
import { KanbanService } from '../src/ws/kanban.service';
import { Actor } from '@muneral/types';

const humanActor: Actor = { type: 'human', id: 'user-1', name: 'Pavel' };

const MOCK_PROJECT = { id: 'proj-1', workspaceId: 'ws-1', name: 'Test' };
const MOCK_TASK = {
  id: 'task-1',
  projectId: 'proj-1',
  title: 'Test task',
  status: 'todo' as const,
  priority: 'medium' as const,
};

const makePrisma = () => ({
  project: {
    findUnique: jest.fn(),
  },
  task: {
    create: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn().mockResolvedValue([]),
    update: jest.fn(),
    delete: jest.fn().mockResolvedValue(undefined),
  },
  taskTag: {
    createMany: jest.fn().mockResolvedValue({ count: 0 }),
  },
  taskChecklist: {
    create: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
    delete: jest.fn().mockResolvedValue(undefined),
    findMany: jest.fn().mockResolvedValue([]),
  },
  taskDependency: {
    create: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn().mockResolvedValue([]),
    delete: jest.fn().mockResolvedValue(undefined),
  },
});

const makeActivityService = () => ({
  log: jest.fn().mockResolvedValue({}),
  findForTask: jest.fn().mockResolvedValue({ data: [], total: 0, page: 1, limit: 20 }),
});

const makeKanbanService = () => ({
  notify: jest.fn(),
});

describe('TasksService', () => {
  let service: TasksService;
  let prisma: ReturnType<typeof makePrisma>;
  let activityService: ReturnType<typeof makeActivityService>;
  let kanbanService: ReturnType<typeof makeKanbanService>;

  beforeEach(async () => {
    prisma = makePrisma();
    activityService = makeActivityService();
    kanbanService = makeKanbanService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TasksService,
        { provide: PrismaService, useValue: prisma },
        { provide: ActivityService, useValue: activityService },
        { provide: KanbanService, useValue: kanbanService },
      ],
    }).compile();

    service = module.get<TasksService>(TasksService);
  });

  describe('create', () => {
    it('creates a task and logs activity', async () => {
      prisma.project.findUnique.mockResolvedValue(MOCK_PROJECT);
      prisma.task.create.mockResolvedValue({ ...MOCK_TASK, id: 'task-new' });

      const result = await service.create(humanActor, {
        projectId: 'proj-1',
        title: 'Test task',
      });

      expect(prisma.task.create).toHaveBeenCalled();
      expect(activityService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'task:created' }),
      );
      expect(kanbanService.notify).toHaveBeenCalledWith(
        'proj-1',
        'task:created',
        expect.anything(),
      );
    });

    it('throws NotFoundException for missing project', async () => {
      prisma.project.findUnique.mockResolvedValue(null);

      await expect(
        service.create(humanActor, { projectId: 'missing', title: 'Fail' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateStatus (state machine)', () => {
    it('allows valid transition and logs it', async () => {
      prisma.task.findUnique.mockResolvedValue({ ...MOCK_TASK });
      prisma.project.findUnique.mockResolvedValue(MOCK_PROJECT);
      prisma.task.update.mockResolvedValue({ ...MOCK_TASK, status: 'in_progress' });

      const result = await service.updateStatus('task-1', humanActor, {
        status: 'in_progress',
      });

      expect(result.status).toBe('in_progress');
      expect(activityService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'task:status_changed',
          payload: { from: 'todo', to: 'in_progress' },
        }),
      );
      expect(kanbanService.notify).toHaveBeenCalledWith(
        'proj-1',
        'task:moved',
        expect.objectContaining({ from: 'todo', to: 'in_progress' }),
      );
    });

    it('throws BadRequestException for invalid transition', async () => {
      prisma.task.findUnique.mockResolvedValue({ ...MOCK_TASK, status: 'todo' });
      prisma.project.findUnique.mockResolvedValue(MOCK_PROJECT);

      await expect(
        service.updateStatus('task-1', humanActor, { status: 'done' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException for missing task', async () => {
      prisma.task.findUnique.mockResolvedValue(null);

      await expect(
        service.updateStatus('missing', humanActor, { status: 'in_progress' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('delete', () => {
    it('removes task and emits WS event', async () => {
      prisma.task.findUnique.mockResolvedValue({ ...MOCK_TASK });
      prisma.project.findUnique.mockResolvedValue(MOCK_PROJECT);

      await service.delete('task-1', humanActor);

      expect(prisma.task.delete).toHaveBeenCalled();
      expect(kanbanService.notify).toHaveBeenCalledWith(
        'proj-1',
        'task:deleted',
        { taskId: 'task-1' },
      );
    });
  });
});
