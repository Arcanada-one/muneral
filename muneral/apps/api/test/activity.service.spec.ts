import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ActivityService } from '../src/activity/activity.service';
import { ActivityLog } from '../src/activity/entities/activity-log.entity';
import { Actor } from '@muneral/types';

const mockActor: Actor = { type: 'human', id: 'user-1', name: 'Pavel' };

const makeRepo = () => ({
  create: jest.fn((data) => ({ id: 'log-1', ...data })),
  save: jest.fn((entity) => Promise.resolve(entity)),
  createQueryBuilder: jest.fn().mockReturnValue({
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
  }),
});

describe('ActivityService', () => {
  let service: ActivityService;
  let repo: ReturnType<typeof makeRepo>;

  beforeEach(async () => {
    repo = makeRepo();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ActivityService,
        { provide: getRepositoryToken(ActivityLog), useValue: repo },
      ],
    }).compile();

    service = module.get<ActivityService>(ActivityService);
  });

  describe('log', () => {
    it('creates and saves an activity log entry', async () => {
      const result = await service.log({
        workspaceId: 'ws-1',
        taskId: 'task-1',
        actor: mockActor,
        action: 'task:created',
        payload: { title: 'Fix bug' },
      });

      expect(repo.create).toHaveBeenCalledWith({
        workspaceId: 'ws-1',
        taskId: 'task-1',
        actorType: 'human',
        actorId: 'user-1',
        action: 'task:created',
        payload: { title: 'Fix bug' },
      });
      expect(repo.save).toHaveBeenCalled();
      expect(result).toMatchObject({ action: 'task:created' });
    });

    it('sets taskId to null when not provided', async () => {
      await service.log({
        workspaceId: 'ws-1',
        actor: mockActor,
        action: 'workspace:created',
      });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: null }),
      );
    });

    it('sets payload to null when not provided', async () => {
      await service.log({
        workspaceId: 'ws-1',
        actor: mockActor,
        action: 'some:action',
      });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ payload: null }),
      );
    });

    it('records agent actor type correctly', async () => {
      const agentActor: Actor = { type: 'agent', id: 'agent-1', name: 'Bot' };
      await service.log({
        workspaceId: 'ws-1',
        actor: agentActor,
        action: 'task:updated',
      });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ actorType: 'agent', actorId: 'agent-1' }),
      );
    });
  });

  describe('findForTask', () => {
    it('queries with task ID and returns paginated result', async () => {
      const mockLogs = [{ id: 'log-1', action: 'task:created' }];
      const qb = repo.createQueryBuilder();
      (qb.getManyAndCount as jest.Mock).mockResolvedValue([mockLogs, 1]);

      const result = await service.findForTask('task-1', 1, 20);
      expect(result).toEqual({ data: mockLogs, total: 1, page: 1, limit: 20 });
    });

    it('applies correct pagination skip/take', async () => {
      await service.findForTask('task-1', 3, 10);
      const qb = repo.createQueryBuilder();
      expect(qb.skip).toHaveBeenCalledWith(20); // (3-1)*10
      expect(qb.take).toHaveBeenCalledWith(10);
    });
  });

  describe('findForWorkspace', () => {
    it('returns paginated result for workspace', async () => {
      const result = await service.findForWorkspace('ws-1', 1, 20);
      expect(result).toMatchObject({ page: 1, limit: 20 });
    });
  });
});
