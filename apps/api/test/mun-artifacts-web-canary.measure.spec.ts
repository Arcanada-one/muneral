/**
 * Optional lane/CI-opt-in measurement for the web consumer artifact canary.
 * Skipped unless MUN_ARTIFACT_CANARY_MEASURE=1 so default jest/CI stays inert.
 *
 * Boots disposable Postgres + Nest on 127.0.0.1:25456 (Workspaces + Projects +
 * Tasks), writes MUN_ARTIFACT_CANARY_FIXTURE, then runs
 * apps/web/__tests__/web-consumer-live.test.ts (upload/list/get/by-sha).
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Module, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { v4 as uuidv4 } from 'uuid';
import { describe, it, expect, afterAll, jest } from '@jest/globals';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { TasksModule } from '../src/tasks/tasks.module.js';
import { AgentsModule } from '../src/agents/agents.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { ActivityModule } from '../src/activity/activity.module.js';
import { WorkspacesModule } from '../src/workspaces/workspaces.module.js';
import { ProjectsModule } from '../src/projects/projects.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { AuthService } from '../src/auth/auth.service.js';
import { KanbanService } from '../src/ws/kanban.service.js';
import { createDisposablePostgres } from './support/disposable-postgres.js';

const MEASURE = process.env.MUN_ARTIFACT_CANARY_MEASURE === '1';
const describeCanary = MEASURE ? describe : describe.skip;

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    ActivityModule,
    AgentsModule,
    WorkspacesModule,
    ProjectsModule,
    TasksModule,
  ],
  providers: [{ provide: KanbanService, useValue: { notify: () => void 0 } }],
})
class CanaryAppModule {}

describeCanary('MUN-ARTIFACTS web canary measurement', () => {
  jest.setTimeout(300_000);
  const pg = createDisposablePostgres('mun-artifacts-web-canary');
  const savedUrl = process.env.DATABASE_URL;
  const repoRoot = path.resolve(process.cwd(), '../..');
  const laneRoot = path.resolve(repoRoot, '..');
  const fixturePath =
    process.env.MUN_ARTIFACT_CANARY_FIXTURE ??
    path.join(laneRoot, 'canary-fixture.json');
  const vitestLogPath = path.join(laneRoot, 'canary-vitest.log');
  let app: NestExpressApplication;

  afterAll(async () => {
    if (app) await app.close();
    await pg.stop();
    if (savedUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedUrl;
  }, 120_000);

  it('boots isolated API and runs web consumer upload/list/get/readback canary', async () => {
    await pg.start();
    process.env.DATABASE_URL = pg.url();
    process.env.TELEGRAM_BOT_TOKEN =
      process.env.TELEGRAM_BOT_TOKEN || 'canary-telegram-bot-token';

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [CanaryAppModule],
    })
      .overrideProvider(KanbanService)
      .useValue({ notify: () => void 0 })
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    await app.listen(25456, '127.0.0.1');

    const prisma = moduleRef.get(PrismaService);
    const authSvc = moduleRef.get(AuthService);
    const id = uuidv4().slice(0, 8);
    const owner = await prisma.user.create({ data: { name: `canary-owner-${id}` } });
    const workspace = await prisma.workspace.create({
      data: { slug: `ws-canary-${id}`, name: `WS ${id}`, ownerId: owner.id },
    });
    await prisma.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: owner.id, role: 'viewer' },
    });
    const project = await prisma.project.create({
      data: {
        workspaceId: workspace.id,
        slug: `proj-canary-${id}`,
        name: `Proj ${id}`,
      },
    });
    const creator = await prisma.agent.create({
      data: { workspaceId: workspace.id, name: `creator-${id}` },
    });
    const executor = await prisma.agent.create({
      data: { workspaceId: workspace.id, name: `executor-${id}` },
    });
    const executorKey = (await authSvc.createApiKey(executor.id, 'executor')).key;
    const task = await prisma.task.create({
      data: {
        projectId: project.id,
        title: 'canary artifact task',
        status: 'in_progress',
        priority: 'medium',
        createdById: creator.id,
        actorType: 'agent',
      },
    });
    await prisma.taskAgent.create({
      data: { taskId: task.id, agentId: executor.id, role: 'executor' },
    });
    const accessToken = authSvc.signAccess(owner.id);

    mkdirSync(path.dirname(fixturePath), { recursive: true });
    writeFileSync(
      fixturePath,
      `${JSON.stringify(
        {
          baseUrl: 'http://127.0.0.1:25456',
          accessToken,
          agentKey: executorKey,
          workspaceId: workspace.id,
          workspaceSlug: workspace.slug,
          projectId: project.id,
          projectSlug: project.slug,
          taskId: task.id,
          telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );

    const readyDeadline = Date.now() + 45_000;
    for (;;) {
      try {
        const probe = await fetch('http://127.0.0.1:25456/api/v1/workspaces', {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (probe.status === 200) break;
      } catch {
        // listener not ready yet
      }
      if (Date.now() > readyDeadline) {
        throw new Error(
          'Isolated Nest listener did not become ready on 127.0.0.1:25456',
        );
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    // Async spawn keeps this Jest event loop alive so Nest can serve HTTP while vitest runs.
    // spawnSync would freeze the listener and hang every web request (prior NOT_MEASURED).
    const vitestCli = path.join(repoRoot, 'apps/web/node_modules/vitest/vitest.mjs');
    const vitest = await new Promise<{
      status: number | null;
      signal: NodeJS.Signals | null;
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          vitestCli,
          'run',
          '--test-timeout=30000',
          '__tests__/web-consumer-live.test.ts',
        ],
        {
          cwd: path.join(repoRoot, 'apps/web'),
          env: {
            ...process.env,
            MUN_ARTIFACT_CANARY_FIXTURE: fixturePath,
            PATH: process.env.PATH,
            CI: 'true',
          },
        },
      );
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error('vitest canary exceeded 240s'));
      }, 240_000);
      child.stdout.setEncoding('utf8').on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.setEncoding('utf8').on('data', (chunk) => {
        stderr += chunk;
      });
      child.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.once('close', (status, signal) => {
        clearTimeout(timer);
        resolve({ status, signal, stdout, stderr });
      });
    });
    writeFileSync(
      vitestLogPath,
      `status=${vitest.status}\nsignal=${vitest.signal}\nstdout_bytes=${vitest.stdout.length}\nstderr_bytes=${vitest.stderr.length}\n--- stdout ---\n${vitest.stdout}\n--- stderr ---\n${vitest.stderr}\n`,
      { mode: 0o600 },
    );
    expect(vitest.status).toBe(0);
    // Vitest default reporter prints test titles only on failure; success shows counts.
    expect(vitest.stdout).toMatch(/Test Files\s+1 passed/);
    expect(vitest.stdout).toMatch(/Tests\s+5 passed/);
  });
});
