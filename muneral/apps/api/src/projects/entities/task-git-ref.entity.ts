import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Task } from '../../tasks/entities/task.entity';
import { GitRefType } from '@muneral/types';

@Entity('task_git_refs')
export class TaskGitRef {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'task_id', type: 'uuid' })
  taskId: string;

  @ManyToOne(() => Task)
  @JoinColumn({ name: 'task_id' })
  task: Task;

  @Column({ type: 'varchar', enum: ['repo', 'branch', 'commit'] })
  type: GitRefType;

  @Column({ type: 'varchar' })
  url: string;

  @Column({ type: 'varchar', nullable: true })
  ref: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
