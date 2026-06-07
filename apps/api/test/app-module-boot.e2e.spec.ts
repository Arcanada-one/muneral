/**
 * Regression test: full AppModule DI graph compiles without errors.
 *
 * Purpose: catch "green tests, dead app" defects where a module is removed from
 * another module's `imports` array (e.g. AuthModule removed from SyncModule),
 * causing UnknownDependenciesException at boot even though unit/e2e suites that
 * use a minimal TestAppModule stay green.
 *
 * Strategy: build a BootTestModule that mirrors AppModule's full feature-module
 * graph. BullModule.forRootAsync and WebhooksModule are the only parts that
 * require a live Redis connection, so WebhooksModule is replaced by a no-op
 * stub that provides the same export token (WebhooksService) without enqueuing.
 * Everything else — including SyncModule → ApiKeyGuard → AuthService →
 * AuthModule — must resolve correctly or .compile() throws
 * UnknownDependenciesException and the test fails.
 */
import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { Test } from '@nestjs/testing';

import { PrismaModule } from '../src/prisma/prisma.module';
import { AuthModule } from '../src/auth/auth.module';
import { WorkspacesModule } from '../src/workspaces/workspaces.module';
import { ProjectsModule } from '../src/projects/projects.module';
import { MilestonesModule } from '../src/milestones/milestones.module';
import { TasksModule } from '../src/tasks/tasks.module';
import { AgentsModule } from '../src/agents/agents.module';
import { ActivityModule } from '../src/activity/activity.module';
import { SyncModule } from '../src/sync/sync.module';
import { WsModule } from '../src/ws/ws.module';
import { HealthController } from '../src/health.controller';
import { WebhooksService } from '../src/webhooks/webhooks.service';

/**
 * Stub that satisfies any consumer of WebhooksService without registering a
 * BullMQ queue (which would require a live Redis connection).
 */
@Module({
  providers: [
    {
      provide: WebhooksService,
      useValue: {
        create: jest.fn(),
        findAll: jest.fn(),
        remove: jest.fn(),
        dispatch: jest.fn(),
      },
    },
  ],
  exports: [WebhooksService],
})
class WebhooksStubModule {}

/**
 * Mirrors AppModule's full feature-module set, substituting only the
 * Redis-dependent parts so the test runs without infrastructure.
 * SyncModule — the module whose missing AuthModule import was the defect —
 * is imported fully and without any override.
 */
@Module({
  imports: [
    PrismaModule,
    ThrottlerModule.forRoot([{ name: 'global', ttl: 1000, limit: 30 }]),
    AuthModule,
    WorkspacesModule,
    ProjectsModule,
    MilestonesModule,
    TasksModule,
    AgentsModule,
    ActivityModule,
    SyncModule,       // ← the defect site; must import AuthModule itself
    WebhooksStubModule,
    WsModule,
  ],
  controllers: [HealthController],
})
class BootTestModule {}

describe('AppModule boot (DI regression)', () => {
  it('bootstraps the full AppModule without DI resolution errors', async () => {
    // .compile() throws UnknownDependenciesException synchronously if any
    // provider cannot be resolved. If SyncModule is missing AuthModule, this
    // assertion is never reached and the test fails with a clear DI error.
    const moduleRef = await Test.createTestingModule({
      imports: [BootTestModule],
    }).compile();

    expect(moduleRef).toBeDefined();

    // Confirm SyncController is in the graph — proves ApiKeyGuard resolved
    // through the SyncModule → AuthModule → ApiKeyGuard chain.
    const { SyncController } = await import('../src/sync/sync.controller');
    const syncController = moduleRef.get(SyncController, { strict: false });
    expect(syncController).toBeDefined();

    await moduleRef.close();
  });
});
