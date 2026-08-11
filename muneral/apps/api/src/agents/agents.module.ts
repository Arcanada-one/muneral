import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Agent } from './entities/agent.entity';
import { ApiKey } from './entities/api-key.entity';
import { TaskAgent } from './entities/task-agent.entity';
import { AgentsService } from './agents.service';
import { AgentsController } from './agents.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [TypeOrmModule.forFeature([Agent, ApiKey, TaskAgent]), AuthModule],
  controllers: [AgentsController],
  providers: [AgentsService],
  exports: [AgentsService, TypeOrmModule],
})
export class AgentsModule {}
