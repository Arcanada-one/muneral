import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { KanbanGateway } from './kanban.gateway.js';
import { KanbanService } from './kanban.service.js';

@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET ?? 'change-me-in-production',
    }),
  ],
  providers: [KanbanGateway, KanbanService],
  exports: [KanbanService],
})
export class WsModule {}
