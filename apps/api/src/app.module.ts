import { Module } from '@nestjs/common';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { BullModule } from '@nestjs/bullmq';
import { APP_GUARD } from '@nestjs/core';

// Prisma
import { PrismaModule } from './prisma/prisma.module';

// Health
import { HealthController } from './health.controller';

// Feature modules
import { AuthModule } from './auth/auth.module';
import { WorkspacesModule } from './workspaces/workspaces.module';
import { ProjectsModule } from './projects/projects.module';
import { MilestonesModule } from './milestones/milestones.module';
import { TasksModule } from './tasks/tasks.module';
import { AgentsModule } from './agents/agents.module';
import { ActivityModule } from './activity/activity.module';
import { SyncModule } from './sync/sync.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { WsModule } from './ws/ws.module';
import { SolutionLogHeadModule } from './solution-log-head/solution-log-head.module';
import { MigrationModule } from './migration/migration.module';

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
