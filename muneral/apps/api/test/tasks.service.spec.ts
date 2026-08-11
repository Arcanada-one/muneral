import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TasksService } from '../src/tasks/tasks.service';
import { Task } from '../src/tasks/entities/task.entity';
import { TaskTag } from '../src/tasks/entities/task-tag.entity';
import { TaskChecklist } from '../src/tasks/entities/task-checklist.entity';
import { TaskDependency } from '../src/tasks/entities/task-dependency.entity';
import { Project } from '../src/projects/entities/project.entity';
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

const makeTaskRepo = () => ({
  findOne: jest.fn(),
  create: jest.fn((data) => ({ id: 'task-new', ...data })),
  save: jest.fn((entity) => Promise.resolve(entity)),
  remove: jest.fn().mockResolvedValue(undefined),
  createQueryBuilder: jest.fn().mockReturnValue({
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
  }),
});

const makeGenericRepo = () => ({
  findOne: jest.fn(),
  create: jest.fn((data) => ({ id: 'item-new', ...data })),
  save: jest.fn((entity) => Promise.resolve(entity)),
  remove: jest.fn().mockResolvedValue(undefined),
  createQueryBuilder: jest.fn().mockReturnValue({
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
  }),
});

const makeProjectRepo = () => ({
  findOne: jest.fn().mockResolvedValue(MOCK_PROJECT),
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
  let taskRepo: ReturnType<typeof makeTaskRepo>;
  let activityService: ReturnType<typeof makeActivityService>;
  let kanbanService: ReturnType<typeof makeKanbanService>;

  beforeEach(async () => {
    taskRepo = makeTaskRepo();
    activityService = makeActivityService();
    kanbanService = makeKanbanService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TasksService,
        { provide: getRepositoryToken(Task), useValue: taskRepo },
        { provide: getRepositoryToken(TaskTag), useValue: makeGenericRepo() },
        { provide: getRepositoryToken(TaskChecklist), useValue: makeGenericRepo() },
        { provide: getRepositoryToken(TaskDependency), useValue: makeGenericRepo() },
        { provide: getRepositoryToken(Project), useValue: makeProjectRepo() },
        { provide: ActivityService, useValue: activityService },
        { provide: KanbanService, useValue: kanbanService },
      ],
    }).compile();

    service = module.get<TasksService>(TasksService);
  });

  describe('create', () => {
    it('creates a task and logs activity', async () => {
      taskRepo.save.mockResolvedValue({ ...MOCK_TASK, id: 'task-new' });

      const result = await service.create(humanActor, {
        projectId: 'proj-1',
        title: 'Test task',
      });

      expect(taskRepo.create).toHaveBeenCalled();
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
      const projectRepo = { findOne: jest.fn().mockResolvedValue(null) };

      const module = await Test.createTestingModule({
        providers: [
          TasksService,
          { provide: getRepositoryToken(Task), useValue: taskRepo },
          { provide: getRepositoryToken(TaskTag), useValue: makeGenericRepo() },
          { provide: getRepositoryToken(TaskChecklist), useValue: makeGenericRepo() },
          { provide: getRepositoryToken(TaskDependency), useValue: makeGenericRepo() },
          { provide: getRepositoryToken(Project), useValue: projectRepo },
          { provide: ActivityService, useValue: activityService },
          { provide: KanbanService, useValue: kanbanService },
        ],
      }).compile();

      const svc = module.get<TasksService>(TasksService);
      await expect(
        svc.create(humanActor, { projectId: 'missing', title: 'Fail' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateStatus (state machine)', () => {
    it('allows valid transition and logs it', async () => {
      taskRepo.findOne.mockResolvedValue({ ...MOCK_TASK });
      taskRepo.save.mockImplementation((t) => Promise.resolve(t));

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
      taskRepo.findOne.mockResolvedValue({ ...MOCK_TASK, status: 'todo' });

      await expect(
        service.updateStatus('task-1', humanActor, { status: 'done' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException for missing task', async () => {
      taskRepo.findOne.mockResolvedValue(null);

      await expect(
        service.updateStatus('missing', humanActor, { status: 'in_progress' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('delete', () => {
    it('removes task and emits WS event', async () => {
      taskRepo.findOne.mockResolvedValue({ ...MOCK_TASK });

      await service.delete('task-1', humanActor);

      expect(taskRepo.remove).toHaveBeenCalled();
      expect(kanbanService.notify).toHaveBeenCalledWith(
        'proj-1',
        'task:deleted',
        { taskId: 'task-1' },
      );
    });
  });
});
