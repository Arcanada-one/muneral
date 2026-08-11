import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SyncService } from './sync.service';
import { SyncController } from './sync.controller';
import { Task } from '../tasks/entities/task.entity';
import { Project } from '../projects/entities/project.entity';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [TypeOrmModule.forFeature([Task, Project]), AuthModule],
  controllers: [SyncController],
  providers: [SyncService],
})
export class SyncModule {}
