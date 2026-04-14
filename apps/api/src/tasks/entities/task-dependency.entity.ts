import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Task } from './task.entity';
import { TaskDependencyType } from '@muneral/types';

@Entity('task_dependencies')
export class TaskDependency {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'from_task_id', type: 'uuid' })
  fromTaskId: string;

  @ManyToOne(() => Task)
  @JoinColumn({ name: 'from_task_id' })
  fromTask: Task;

  @Column({ name: 'to_task_id', type: 'uuid' })
  toTaskId: string;

  @ManyToOne(() => Task)
  @JoinColumn({ name: 'to_task_id' })
  toTask: Task;

  @Column({
    type: 'varchar',
    enum: ['depends_on', 'blocks', 'related_to', 'duplicates'],
  })
  type: TaskDependencyType;
}
