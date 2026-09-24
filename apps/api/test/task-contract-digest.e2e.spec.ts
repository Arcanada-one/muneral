/**
 * A2-267 (e2e) — a task carries the KC2 contract digest it was admitted under,
 * as a first-class field.
 *
 * Before this, `POST /tasks` refused `contractDigest` with 400 (the global pipe
 * runs `forbidNonWhitelisted`), so Argana's intake wrote the digest as a line
 * inside `description`. Each test below names the half of the change it would
 * go red without:
 *
 *   create accepts it          CreateTaskDto.contractDigest
 *   create stores it           TasksService.create `contractDigest: dto.contractDigest ?? null`
 *   reads return it            the column itself (GET /tasks/:id, GET /agents/tasks)
 *   malformed is refused       the DTO's @Matches
 *   the query filters on it    QueryTasksDto.contractDigest + the `where` clause
 *   the database refuses junk  the CHECK in 20260924120000_add_task_contract_digest
 *
 * The pipe here is main.ts's own (`whitelist` + `forbidNonWhitelisted`), not the
 * laxer `whitelist`-only pipe other e2e suites use: under the laxer pipe an
 * undeclared `contractDigest` is silently STRIPPED, and the create test would
 * then fail on the stored value instead of on the 400 production gives.
 *
 * Real Prisma against the DATABASE_URL database, fixtures per test.
 */
import supertest from 'supertest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe, Module } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
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

const DIGEST_A = `sha256:${'a1'.repeat(32)}`;
const DIGEST_B = `sha256:${'b2'.repeat(32)}`;

describe('Task contract digest (A2-267, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authSvc: AuthService;

  let userId: string;
  let workspaceId: string;
  let projectId: string;
  let agentId: string;
  let agentKey: string;

  const http = () => supertest(app.getHttpServer());

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [TestAppModule],
    })
      .overrideProvider(KanbanService)
      .useValue({ notify: () => void 0 })
      .compile();

    app = moduleRef.createNestApplication();
    // Exactly src/main.ts's pipe — see the header for why it matters here.
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    prisma = moduleRef.get(PrismaService);
    authSvc = moduleRef.get(AuthService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    const id = uuidv4().slice(0, 8);
    const user = await prisma.user.create({ data: { name: `a2267-${id}` } });
    userId = user.id;
    workspaceId = (
      await prisma.workspace.create({
        data: { slug: `ws-a2267-${id}`, name: `WS ${id}`, ownerId: user.id },
      })
    ).id;
    projectId = (
      await prisma.project.create({
        data: { workspaceId, slug: `proj-a2267-${id}`, name: `Proj ${id}` },
      })
    ).id;
    const agent = await prisma.agent.create({ data: { workspaceId, name: `intake-${id}` } });
    agentId = agent.id;
    agentKey = (await authSvc.createApiKey(agent.id, 'intake')).key;
  });

  afterEach(async () => {
    // None of these tasks is ever moved to in_progress/done/cancelled, so none
    // records an (append-only) execution transition and all of them delete.
    const taskIds = await prisma.task
      .findMany({ where: { projectId }, select: { id: true } })
      .then((rows) => rows.map((r) => r.id));
    if (taskIds.length > 0) {
      await prisma.taskAgent.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.taskTag.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.taskFieldState.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.activityLog.deleteMany({ where: { taskId: { in: taskIds } } });
      await prisma.task.deleteMany({ where: { id: { in: taskIds } } });
    }
    await prisma.activityLog.deleteMany({ where: { workspaceId } });
    await prisma.project.delete({ where: { id: projectId } }).catch(() => void 0);
    await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => void 0);
  });

  function createWithKey(body: Record<string, unknown>) {
    return http()
      .post('/tasks')
      .set('Authorization', `Bearer ${agentKey}`)
      .send({ projectId, title: 'A2-267 intake work item', ...body });
  }

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  it('accepts contractDigest on create, returns it, and stores it in the column', async () => {
    const res = await createWithKey({ contractDigest: DIGEST_A }).expect(201);

    expect(res.body.contractDigest).toBe(DIGEST_A);
    const row = await prisma.task.findUnique({ where: { id: res.body.id } });
    expect(row?.contractDigest).toBe(DIGEST_A);
  });

  it('leaves the field null when a task is created without a contract', async () => {
    const res = await createWithKey({}).expect(201);

    // The KEY is present and null — absence and "no contract" are not the same answer.
    expect(res.body).toHaveProperty('contractDigest', null);
    const row = await prisma.task.findUnique({ where: { id: res.body.id } });
    expect(row?.contractDigest).toBeNull();
  });

  it.each([
    ['uppercase hex', `sha256:${'A1'.repeat(32)}`],
    ['63 hex digits', `sha256:${'a'.repeat(63)}`],
    ['65 hex digits', `sha256:${'a'.repeat(65)}`],
    ['no algorithm prefix', 'a1'.repeat(32)],
    ['another algorithm', `sha512:${'a1'.repeat(32)}`],
    ['a trailing newline', `${DIGEST_A}\n`],
    ['a non-hex digit', `sha256:${'g'.repeat(64)}`],
    ['a number', 42],
  ])('refuses a malformed digest (%s) with 400 and creates nothing', async (_label, bad) => {
    const res = await createWithKey({ contractDigest: bad }).expect(400);

    expect(JSON.stringify(res.body.message)).toContain('contractDigest');
    expect(await prisma.task.count({ where: { projectId } })).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  it('is returned by GET /tasks/:id to the agent that created the task', async () => {
    const created = await createWithKey({ contractDigest: DIGEST_A }).expect(201);

    const res = await http()
      .get(`/tasks/${created.body.id}`)
      .set('Authorization', `Bearer ${agentKey}`)
      .expect(200);

    expect(res.body.contractDigest).toBe(DIGEST_A);
  });

  it('is returned by GET /agents/tasks, the executing agent\'s own list', async () => {
    const created = await createWithKey({ contractDigest: DIGEST_A }).expect(201);
    await prisma.taskAgent.create({
      data: { taskId: created.body.id, agentId, role: 'executor' },
    });

    const res = await http()
      .get('/agents/tasks')
      .set('Authorization', `Bearer ${agentKey}`)
      .expect(200);

    const mine = (res.body as Array<{ task: { id: string; contractDigest: string | null } }>)
      .find((row) => row.task.id === created.body.id);
    expect(mine).toBeDefined();
    expect(mine?.task.contractDigest).toBe(DIGEST_A);
  });

  // -------------------------------------------------------------------------
  // Filter
  // -------------------------------------------------------------------------

  it('GET /tasks?contractDigest= returns exactly the work items of that contract', async () => {
    const a = await createWithKey({ contractDigest: DIGEST_A }).expect(201);
    await createWithKey({ contractDigest: DIGEST_B }).expect(201);
    await createWithKey({}).expect(201);

    const res = await http()
      .get('/tasks')
      .query({ projectId, contractDigest: DIGEST_A })
      .set('Authorization', `Bearer ${authSvc.signAccess(userId)}`)
      .expect(200);

    expect(res.body.total).toBe(1);
    expect(res.body.items.map((t: { id: string }) => t.id)).toEqual([a.body.id]);
  });

  it('GET /tasks refuses a malformed contractDigest filter with 400 rather than an empty page', async () => {
    const res = await http()
      .get('/tasks')
      .query({ projectId, contractDigest: 'sha256:nope' })
      .set('Authorization', `Bearer ${authSvc.signAccess(userId)}`)
      .expect(400);

    expect(JSON.stringify(res.body.message)).toContain('contractDigest');
  });

  // -------------------------------------------------------------------------
  // The database holds the format too
  // -------------------------------------------------------------------------

  it('the tasks_contract_digest_format CHECK refuses a malformed value written around the DTO', async () => {
    const task = await prisma.task.create({
      data: { projectId, title: 'written around the DTO', actorType: 'human' },
    });

    await expect(
      prisma.$executeRawUnsafe(
        'UPDATE public.tasks SET contract_digest = $1 WHERE id = $2::uuid',
        'sha256:NOT-A-DIGEST',
        task.id,
      ),
    ).rejects.toThrow(/tasks_contract_digest_format/);

    // …and admits a well-formed one through the same door.
    await prisma.$executeRawUnsafe(
      'UPDATE public.tasks SET contract_digest = $1 WHERE id = $2::uuid',
      DIGEST_B,
      task.id,
    );
    const row = await prisma.task.findUnique({ where: { id: task.id } });
    expect(row?.contractDigest).toBe(DIGEST_B);
  });
});
