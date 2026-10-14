import supertest from 'supertest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { TasksModule } from '../src/tasks/tasks.module.js';
import { AgentsModule } from '../src/agents/agents.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { ActivityModule } from '../src/activity/activity.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import { KanbanService } from '../src/ws/kanban.service.js';

@Module({
  imports: [PrismaModule, AuthModule, ActivityModule, AgentsModule, TasksModule],
  providers: [{ provide: KanbanService, useValue: { notify: () => void 0 } }],
})
class TestAppModule {}

describe('DELETE /tasks/:taskId — retained deletion audit (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;
  let userId: string;
  let workspaceId: string;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({ imports: [TestAppModule] })
      .overrideProvider(KanbanService)
      .useValue({ notify: () => void 0 })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = moduleRef.get(PrismaService);
    auth = moduleRef.get(AuthService);
  });

  afterAll(async () => {
    if (workspaceId) await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => void 0);
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => void 0);
    await app.close();
  });

  it('deletes the task and retains task:deleted in the workspace audit with its FK set null', async () => {
    const run = randomUUID().slice(0, 8);
    const title = `synthetic delete audit ${run}`;
    userId = (await prisma.user.create({ data: { name: `delete-audit-${run}` } })).id;
    workspaceId = (
      await prisma.workspace.create({
        data: { slug: `delete-audit-${run}`, name: `Delete audit ${run}`, ownerId: userId },
      })
    ).id;
    await prisma.workspaceMember.create({ data: { workspaceId, userId, role: 'owner' } });
    const project = await prisma.project.create({
      data: { workspaceId, slug: `delete-audit-${run}`, name: `Delete audit ${run}` },
    });
    const task = await prisma.task.create({
      data: {
        projectId: project.id,
        title,
        status: 'todo',
        priority: 'medium',
        createdById: userId,
        actorType: 'human',
      },
    });

    await supertest(app.getHttpServer())
      .delete(`/tasks/${task.id}`)
      .set('Authorization', `Bearer ${auth.signAccess(userId)}`)
      .expect(204);

    expect(await prisma.task.findUnique({ where: { id: task.id } })).toBeNull();
    const audits = await prisma.activityLog.findMany({
      where: { workspaceId, action: 'task:deleted', actorId: userId },
    });
    expect(audits).toHaveLength(1);
    const [audit] = audits;
    expect(audit.taskId).toBeNull();
    expect(audit.actorType).toBe('human');
    expect(audit.payload).toEqual({ title });
  });
});
