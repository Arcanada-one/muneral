import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ProjectMembershipService } from '../plan-graph/project-membership.service.js';
import { KanbanGateway } from './kanban.gateway.js';
import { KanbanService } from './kanban.service.js';

@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET ?? 'change-me-in-production',
    }),
  ],
  providers: [ProjectMembershipService, KanbanGateway, KanbanService],
  exports: [KanbanService],
})
export class WsModule {}
