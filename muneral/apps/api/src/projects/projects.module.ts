import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Project } from './entities/project.entity';
import { TaskGitRef } from './entities/task-git-ref.entity';
import { ProjectsService } from './projects.service';
import { ProjectsController } from './projects.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Project, TaskGitRef])],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService, TypeOrmModule],
})
export class ProjectsModule {}
