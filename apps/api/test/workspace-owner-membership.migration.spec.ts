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

  it('adds only the missing owner rows, lets those owners write, and does nothing the second time', async () => {
    const [alone, shared, complete, demoted, colleague, viewer] = [
      await user('alone'), await user('shared'), await user('complete'), await user('demoted'),
      await user('colleague'), await user('viewer')];
    const missingEmpty = await workspace(alone.id, []);
    const missingBesideOthers = await workspace(shared.id, [[colleague.id, 'manager'], [viewer.id, 'viewer']]);
    await workspace(complete.id, [[complete.id, 'owner'], [viewer.id, 'developer']]);
    // An owner who has a row with another role keeps it as it is.
    const otherRole = await workspace(demoted.id, [[demoted.id, 'developer']]);

    for (const ws of [missingEmpty, missingBesideOthers]) await comment(ws.ownerId, ws.taskId).expect(403);

    const before = await memberRows();
    const tablesBefore = await otherTables();
    expect(await prisma.$executeRawUnsafe(MIGRATION)).toBe(2);

    const after = await memberRows();
    const added = [missingEmpty, missingBesideOthers].map((ws) => `${ws.id} ${ws.ownerId} owner`).sort();
    expect(after.filter((row) => !before.includes(row)).sort()).toEqual(added);
    expect(after.filter((row) => !added.includes(row))).toEqual(before);
    expect(after).toContain(`${otherRole.id} ${demoted.id} developer`);
    expect(await otherTables()).toEqual(tablesBefore);

    expect(await prisma.$executeRawUnsafe(MIGRATION)).toBe(0);
    expect(await memberRows()).toEqual(after);
    expect(await otherTables()).toEqual(tablesBefore);

    for (const ws of [missingEmpty, missingBesideOthers]) await comment(ws.ownerId, ws.taskId).expect(201);
  });
});
