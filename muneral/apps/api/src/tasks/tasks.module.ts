import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Task } from './entities/task.entity';
import { TaskTag } from './entities/task-tag.entity';
import { TaskChecklist } from './entities/task-checklist.entity';
import { TaskDependency } from './entities/task-dependency.entity';
import { TasksService } from './tasks.service';
import { TasksController } from './tasks.controller';
import { ActivityModule } from '../activity/activity.module';
import { WsModule } from '../ws/ws.module';
import { Project } from '../projects/entities/project.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Task, TaskTag, TaskChecklist, TaskDependency, Project]),
    ActivityModule,
    WsModule,
  ],
  controllers: [TasksController],
  providers: [TasksService],
  exports: [TasksService, TypeOrmModule],
})
export class TasksModule {}
