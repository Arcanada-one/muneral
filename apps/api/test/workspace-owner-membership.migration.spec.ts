/** Migration: ensure every workspace owner has a membership row (real HTTP/PostgreSQL). */
import { Module, ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import supertest from 'supertest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as url from 'node:url';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { ActivityModule } from '../src/activity/activity.module.js';
import { TasksModule } from '../src/tasks/tasks.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import { KanbanService } from '../src/ws/kanban.service.js';
import { createDisposablePostgres } from './support/disposable-postgres.js';

const MIGRATION = readFileSync(path.join(path.dirname(url.fileURLToPath(import.meta.url)),
  '../prisma/migrations/20261127160000_ensure_workspace_owner_membership/migration.sql'), 'utf8');

@Module({ imports: [PrismaModule, AuthModule, ActivityModule, TasksModule] })
class FixtureModule {}

describe('migration: ensure every workspace owner has a membership row', () => {
  const pg = createDisposablePostgres('workspace-owner-membership');
  let app: INestApplication;
  let prisma: PrismaService;
  let auth: AuthService;

  beforeAll(async () => {
    await pg.start();
    process.env.DATABASE_URL = pg.url();
    const mod = await Test.createTestingModule({ imports: [FixtureModule] })
      .overrideProvider(KanbanService).useValue({ notify() {} }).compile();
    app = mod.createNestApplication();
    app.useLogger(false);
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = mod.get(PrismaService);
    auth = mod.get(AuthService);
  }, 120_000);
  afterAll(async () => { if (app) await app.close(); await pg.stop(); }, 120_000);

  const user = (name: string) => prisma.user.create({ data: { name: `${name}-${randomUUID().slice(0, 8)}` } });

  /** A workspace written directly, with exactly the membership rows given. */
  async function workspace(ownerId: string, members: Array<[string, string]>) {
    const slug = `ws-${randomUUID().slice(0, 8)}`;
    const ws = await prisma.workspace.create({ data: { slug, name: slug, ownerId } });
    for (const [userId, role] of members) await prisma.workspaceMember.create({ data: { workspaceId: ws.id, userId, role } });
    const project = await prisma.project.create({ data: { workspaceId: ws.id, slug: `p-${slug}`, name: 'p' } });
    const task = await prisma.task.create({ data: { projectId: project.id, title: 't', status: 'todo', actorType: 'human', createdById: ownerId } });
    return { id: ws.id, ownerId, taskId: task.id };
  }

  const memberRows = async () => (await prisma.workspaceMember.findMany())
    .map((m) => `${m.workspaceId} ${m.userId} ${m.role}`).sort();

  /** A digest of every public table except the membership table. */
  async function otherTables(): Promise<Record<string, string>> {
    const tables = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
      "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> 'workspace_members' ORDER BY 1");
    const state: Record<string, string> = {};
    for (const { name } of tables) {
      const [row] = await prisma.$queryRawUnsafe<Array<{ digest: string }>>(
        `SELECT md5(coalesce(string_agg(t::text, E'\\n' ORDER BY t::text), '')) AS digest FROM public."${name}" t`);
      state[name] = row.digest;
    }
    return state;
  }

  const comment = (ownerId: string, taskId: string) => supertest(app.getHttpServer())
    .post(`/tasks/${taskId}/comments`).auth(auth.signAccess(ownerId), { type: 'bearer' }).send({ body: 'owner write' });

  type Ws = Awaited<ReturnType<typeof workspace>>;
  /** (a) the owner of record has no row, another member is owner; (b) no rows at all; (c) only a
   *  manager row; (d) complete; (e) the owner of record holds 'developer', nobody is owner. */
  let w: Record<'a' | 'b' | 'c' | 'd' | 'e', Ws>;
  let commentBefore: Record<string, number>;
  let before: string[], afterFirst: string[], afterSecond: string[];
  let tablesBefore: Record<string, string>, tablesFirst: Record<string, string>, tablesSecond: Record<string, string>;
  let inserted: number, insertedAgain: number;
  const added = () => afterFirst.filter((row) => !before.includes(row));
  const addedFor = (ws: Ws) => added().filter((row) => row.startsWith(`${ws.id} `));
  const ownerRow = (ws: Ws) => `${ws.id} ${ws.ownerId} owner`;

  beforeAll(async () => {
    const [absent, peer, bare, managed, manager, complete, viewer, developer] = [
      await user('a'), await user('peer'), await user('b'), await user('c'), await user('manager'),
      await user('d'), await user('viewer'), await user('e')];
    w = {
      a: await workspace(absent.id, [[peer.id, 'owner']]),
      b: await workspace(bare.id, []),
      c: await workspace(managed.id, [[manager.id, 'manager']]),
      d: await workspace(complete.id, [[complete.id, 'owner'], [viewer.id, 'developer']]),
      e: await workspace(developer.id, [[developer.id, 'developer']]),
    };
    commentBefore = {};
    for (const [name, ws] of Object.entries(w)) commentBefore[name] = (await comment(ws.ownerId, ws.taskId)).status;
    before = await memberRows();
    tablesBefore = await otherTables();
    inserted = await prisma.$executeRawUnsafe(MIGRATION);
    afterFirst = await memberRows();
    tablesFirst = await otherTables();
    insertedAgain = await prisma.$executeRawUnsafe(MIGRATION);
    afterSecond = await memberRows();
    tablesSecond = await otherTables();
  }, 120_000);

  it('(a) workspace that has another owner: no insert, the owner of record stays refused', async () => {
    expect(commentBefore.a).toBe(403);
    expect(addedFor(w.a)).toEqual([]);
    expect((await comment(w.a.ownerId, w.a.taskId)).status).toBe(403);
  });

  it.each(['b', 'c'] as const)('(%s) workspace without an owner row: one insert, then the owner can write', async (name) => {
    expect(commentBefore[name]).toBe(403);
    expect(addedFor(w[name])).toEqual([ownerRow(w[name])]);
    expect((await comment(w[name].ownerId, w[name].taskId)).status).toBe(201);
  });

  it('(d) complete workspace: no insert', () => {
    expect(commentBefore.d).toBe(201);
    expect(addedFor(w.d)).toEqual([]);
  });

  it('(e) owner of record with another role: no insert, role unchanged', () => {
    expect(commentBefore.e).toBe(201);
    expect(addedFor(w.e)).toEqual([]);
    expect(afterFirst).toContain(`${w.e.id} ${w.e.ownerId} developer`);
  });

  it('inserts nothing else, keeps every earlier row and leaves all other tables as they were', () => {
    expect(inserted).toBe(added().length);
    expect(afterFirst.filter((row) => !added().includes(row))).toEqual(before);
    expect(tablesFirst).toEqual(tablesBefore);
  });

  it('a second run inserts nothing', () => {
    expect(insertedAgain).toBe(0);
    expect(afterSecond).toEqual(afterFirst);
    expect(tablesSecond).toEqual(tablesBefore);
  });
});
