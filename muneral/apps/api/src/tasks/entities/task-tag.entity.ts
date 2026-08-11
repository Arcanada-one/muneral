import { Entity, PrimaryColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Task } from './task.entity';

@Entity('task_tags')
export class TaskTag {
  @PrimaryColumn({ name: 'task_id', type: 'uuid' })
  taskId: string;

  @PrimaryColumn({ type: 'varchar' })
  tag: string;

  @ManyToOne(() => Task)
  @JoinColumn({ name: 'task_id' })
  task: Task;
}
