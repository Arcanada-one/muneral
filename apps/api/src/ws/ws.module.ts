import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { getJwtSecret } from '../auth/jwt-secret.js';
import { ProjectMembershipService } from '../plan-graph/project-membership.service.js';
import { KanbanGateway } from './kanban.gateway.js';
import { KanbanService } from './kanban.service.js';

@Module({
  imports: [
    JwtModule.register({
      secret: getJwtSecret(),
    }),
  ],
  providers: [ProjectMembershipService, KanbanGateway, KanbanService],
  exports: [KanbanService],
})
export class WsModule {}
