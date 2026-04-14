import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { BullModule } from '@nestjs/bullmq';
import { APP_GUARD } from '@nestjs/core';

// Entities
import { User } from './common/entities/user.entity';
import { Workspace } from './workspaces/entities/workspace.entity';
import { WorkspaceMember } from './workspaces/entities/workspace-member.entity';
import { Project } from './projects/entities/project.entity';
import { TaskGitRef } from './projects/entities/task-git-ref.entity';
import { Milestone } from './milestones/entities/milestone.entity';
import { Sprint } from './milestones/entities/sprint.entity';
import { Task } from './tasks/entities/task.entity';
import { TaskTag } from './tasks/entities/task-tag.entity';
import { TaskChecklist } from './tasks/entities/task-checklist.entity';
import { TaskDependency } from './tasks/entities/task-dependency.entity';
import { Agent } from './agents/entities/agent.entity';
import { ApiKey } from './agents/entities/api-key.entity';
import { TaskAgent } from './agents/entities/task-agent.entity';
import { ActivityLog } from './activity/entities/activity-log.entity';
import { WebhookConfig } from './webhooks/entities/webhook-config.entity';

// Health
import { HealthController } from './health.controller';

// Modules
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

@Module({
  controllers: [HealthController],
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      url: process.env.DATABASE_URL,
      entities: [
        User,
        Workspace,
        WorkspaceMember,
        Project,
        TaskGitRef,
        Milestone,
        Sprint,
        Task,
        TaskTag,
        TaskChecklist,
        TaskDependency,
        Agent,
        ApiKey,
        TaskAgent,
        ActivityLog,
        WebhookConfig,
      ],
      // Use migrations in production; synchronize only in dev/test
      synchronize: process.env.NODE_ENV !== 'production',
      ssl:
        process.env.NODE_ENV === 'production'
          ? { rejectUnauthorized: false }
          : false,
      logging: process.env.NODE_ENV === 'development',
    }),
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
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
