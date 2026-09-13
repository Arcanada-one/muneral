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

import { PrismaModule } from '../src/prisma/prisma.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { WorkspacesModule } from '../src/workspaces/workspaces.module.js';
import { ProjectsModule } from '../src/projects/projects.module.js';
import { MilestonesModule } from '../src/milestones/milestones.module.js';
import { TasksModule } from '../src/tasks/tasks.module.js';
import { AgentsModule } from '../src/agents/agents.module.js';
import { ActivityModule } from '../src/activity/activity.module.js';
import { SyncModule } from '../src/sync/sync.module.js';
import { WsModule } from '../src/ws/ws.module.js';
import { HealthController } from '../src/health.controller.js';
import { WebhooksService } from '../src/webhooks/webhooks.service.js';
import { MigrationModule } from '../src/migration/migration.module.js';
// ESM has no injected globals, so `jest` must be imported for the RUNTIME.
// Its type, though, comes from @types/jest (already in tsconfig `types`),
// which is what the 339 existing jest.fn() call sites are written against —
// @jest/globals ships a stricter generic whose bare jest.fn() infers `never`
// and would red 416 lines that are not otherwise wrong. Value from one,
// type from the other.
import { jest as _jestRuntime } from '@jest/globals';
// Imported statically. Under ESM a dynamic import inside the test body can
// still be resolving when jest tears the environment down, which surfaces as
// `import after the Jest environment has been torn down` — 137 of them from
// this one suite, and the noise lands on whichever suites run alongside it.
import { SyncController } from '../src/sync/sync.controller.js';
import { MigrationController } from '../src/migration/migration.controller.js';
const jest = _jestRuntime as unknown as typeof globalThis.jest;

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
    MigrationModule,  // MUN-0040: resolves ApiKeyGuard + JwtOrApiKeyGuard + ActivityService
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
    const syncController = moduleRef.get(SyncController, { strict: false });
    expect(syncController).toBeDefined();

    // Same proof for MUN-0040: MigrationModule pulls ApiKeyGuard and
    // JwtOrApiKeyGuard from AuthModule and ActivityService from ActivityModule,
    // so a missing import here fails at .compile() rather than at first request.
    expect(moduleRef.get(MigrationController, { strict: false })).toBeDefined();

    await moduleRef.close();
  });
});
