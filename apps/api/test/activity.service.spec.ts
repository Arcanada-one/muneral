import { Prisma } from '@prisma/client';
import { Test, TestingModule } from '@nestjs/testing';
import { ActivityService } from '../src/activity/activity.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { Actor } from '@muneral/types';

const mockActor: Actor = { type: 'human', id: 'user-1', name: 'Pavel' };

const makePrisma = () => ({
  activityLog: {
    create: jest.fn((args) => Promise.resolve({ id: 'log-1', ...args.data })),
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
  },
});

describe('ActivityService', () => {
  let service: ActivityService;
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(async () => {
    prisma = makePrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ActivityService,
        { provide: PrismaService, useValue: prisma },
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

      expect(prisma.activityLog.create).toHaveBeenCalledWith({
        data: {
          workspaceId: 'ws-1',
          taskId: 'task-1',
          actorType: 'human',
          actorId: 'user-1',
          action: 'task:created',
          payload: { title: 'Fix bug' },
        },
      });
      expect(result).toMatchObject({ action: 'task:created' });
    });

    it('sets taskId to null when not provided', async () => {
      await service.log({
        workspaceId: 'ws-1',
        actor: mockActor,
        action: 'workspace:created',
      });

      expect(prisma.activityLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ taskId: null }),
        }),
      );
    });

    it('sets payload to null when not provided', async () => {
      await service.log({
        workspaceId: 'ws-1',
        actor: mockActor,
        action: 'some:action',
      });

      expect(prisma.activityLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ payload: Prisma.DbNull }),
        }),
      );
    });

    it('records agent actor type correctly', async () => {
      const agentActor: Actor = { type: 'agent', id: 'agent-1', name: 'Bot' };
      await service.log({
        workspaceId: 'ws-1',
        actor: agentActor,
        action: 'task:updated',
      });

      expect(prisma.activityLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ actorType: 'agent', actorId: 'agent-1' }),
        }),
      );
    });
  });

  describe('findForTask', () => {
    it('queries with task ID and returns paginated result', async () => {
      const mockLogs = [{ id: 'log-1', action: 'task:created' }];
      prisma.activityLog.findMany.mockResolvedValue(mockLogs);
      prisma.activityLog.count.mockResolvedValue(1);

      const result = await service.findForTask('task-1', 1, 20);
      expect(result).toEqual({ data: mockLogs, total: 1, page: 1, limit: 20 });
    });

    it('applies correct pagination skip/take', async () => {
      await service.findForTask('task-1', 3, 10);
      expect(prisma.activityLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 10 }),
      );
    });
  });

  describe('findForWorkspace', () => {
    it('returns paginated result for workspace', async () => {
      const result = await service.findForWorkspace('ws-1', 1, 20);
      expect(result).toMatchObject({ page: 1, limit: 20 });
    });
  });
});
