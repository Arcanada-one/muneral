import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import supertest from 'supertest';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { AuthService } from '../src/auth/auth.service.js';
import { WorkspacesModule } from '../src/workspaces/workspaces.module.js';
import { createDisposablePostgres } from './support/disposable-postgres.js';

const routes = [
  { method: 'POST', path: '/api/v1/workspaces/:workspaceId/members/:userId', expected: 201, body: {} },
  { method: 'PATCH', path: '/api/v1/workspaces/:workspaceId/members/:userId/role', expected: 200, body: { role: 'manager' } },
  { method: 'GET', path: '/api/v1/workspaces/:workspaceId', expected: 200 },
  { method: 'GET', path: '/api/v1/workspaces/:workspaceId/members', expected: 200 },
  { method: 'DELETE', path: '/api/v1/workspaces/:workspaceId/members/:userId', expected: 204 },
] as const;
const run = Math.random().toString(36).slice(2, 10);
const db = createDisposablePostgres('main-workspace-membership');
const previousDatabaseUrl = process.env.DATABASE_URL;
let app: INestApplication;
let prisma: PrismaService;
let ownerJwt: string;
let workspaceId: string;
let targetUserId: string;

beforeAll(async () => {
  await db.start();
  process.env.DATABASE_URL = db.url();
  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [PrismaModule, AuthModule, WorkspacesModule],
  }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.init();
  prisma = moduleRef.get(PrismaService);
  const auth = moduleRef.get(AuthService);
  const owner = await prisma.user.create({ data: { name: `main-owner-${run}` } });
  const target = await prisma.user.create({ data: { name: `main-target-${run}` } });
  targetUserId = target.id;
  const workspace = await prisma.workspace.create({ data: { slug: `main-${run}`, name: `Main check ${run}`, ownerId: owner.id } });
  workspaceId = workspace.id;
  await prisma.workspaceMember.create({ data: { workspaceId, userId: owner.id, role: 'owner' } });
  ownerJwt = auth.signAccess(owner.id);
});

afterAll(async () => {
  try { if (app) await app.close(); } finally {
    try { await db.stop(); } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }
  }
}, 30_000);

describe('workspace membership routes require an authenticated owner', () => {
  const requestFor = (route: typeof routes[number], authenticated = true) => {
    const path = route.path.replace(':workspaceId', workspaceId).replace(':userId', targetUserId);
    const method = route.method.toLowerCase() as 'get' | 'post' | 'patch' | 'delete';
    let request = (supertest(app.getHttpServer()) as any)[method](path);
    if (authenticated) request = request.set('Authorization', `Bearer ${ownerJwt}`);
    if (authenticated && 'body' in route) request = request.send(route.body);
    return request;
  };

  it('POST adds a workspace member', async () => {
    expect((await requestFor(routes[0], false)).status).toBe(401);
    await expect(requestFor(routes[0])).resolves.toMatchObject({ status: 201 });
  });

  it('PATCH updates a workspace member role', async () => {
    expect((await requestFor(routes[1], false)).status).toBe(401);
    await expect(requestFor(routes[1])).resolves.toMatchObject({ status: 200 });
  });

  it('GET reads workspace details', async () => {
    expect((await requestFor(routes[2], false)).status).toBe(401);
    await expect(requestFor(routes[2])).resolves.toMatchObject({ status: 200 });
  });

  it('GET lists workspace members', async () => {
    expect((await requestFor(routes[3], false)).status).toBe(401);
    await expect(requestFor(routes[3])).resolves.toMatchObject({ status: 200 });
  });

  it('DELETE removes a workspace member', async () => {
    expect((await requestFor(routes[4], false)).status).toBe(401);
    await expect(requestFor(routes[4])).resolves.toMatchObject({ status: 204 });
  });
});
