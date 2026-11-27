import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthModule } from '../auth/auth.module.js';
import { getJwtSecret } from '../auth/jwt-secret.js';
import { ProjectMembershipService } from '../plan-graph/project-membership.service.js';
import { KanbanGateway } from './kanban.gateway.js';
import { KanbanService } from './kanban.service.js';

@Module({
  imports: [
    AuthModule,
    JwtModule.register({
      secret: getJwtSecret(),
      // The legacy verifier accepts the one algorithm this API signs with.
      verifyOptions: { algorithms: ['HS256'] },
    }),
  ],
  providers: [ProjectMembershipService, KanbanGateway, KanbanService],
  exports: [KanbanService],
})
export class WsModule {}
