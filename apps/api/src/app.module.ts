import { Module } from '@nestjs/common';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { BullModule } from '@nestjs/bullmq';
import { APP_GUARD } from '@nestjs/core';

// Prisma
import { PrismaModule } from './prisma/prisma.module.js';

// Health
import { HealthController } from './health.controller.js';

// Feature modules
import { AuthModule } from './auth/auth.module.js';
import { WorkspacesModule } from './workspaces/workspaces.module.js';
import { ProjectsModule } from './projects/projects.module.js';
import { MilestonesModule } from './milestones/milestones.module.js';
import { TasksModule } from './tasks/tasks.module.js';
import { AgentsModule } from './agents/agents.module.js';
import { ActivityModule } from './activity/activity.module.js';
import { SyncModule } from './sync/sync.module.js';
import { WebhooksModule } from './webhooks/webhooks.module.js';
import { WsModule } from './ws/ws.module.js';
import { SolutionLogHeadModule } from './solution-log-head/solution-log-head.module.js';
import { MigrationModule } from './migration/migration.module.js';

@Module({
  controllers: [HealthController],
  imports: [
    PrismaModule,
    ThrottlerModule.forRoot([
      {
        name: 'global',
        ttl: 1000,
        limit: parseInt(process.env.RATE_LIMIT_API_PER_SEC ?? '30', 10),
      },
    ]),
    BullModule.forRootAsync({
      useFactory: () => {
        const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
        const password = redisUrl.password ? redisUrl.password : undefined;
        return {
          connection: {
            host: redisUrl.hostname,
            port: parseInt(redisUrl.port || '6379', 10),
            ...(password ? { password } : {}),
            keyPrefix: process.env.REDIS_PREFIX ?? 'muneral:',
          },
        };
      },
    }),
    AuthModule,
    WorkspacesModule,
    ProjectsModule,
    MilestonesModule,
    TasksModule,
    AgentsModule,
    ActivityModule,
    SyncModule,
    WebhooksModule,
    WsModule,
    SolutionLogHeadModule,
    MigrationModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
