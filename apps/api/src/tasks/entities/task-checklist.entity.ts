import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Task } from './task.entity';

@Entity('task_checklists')
export class TaskChecklist {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'task_id', type: 'uuid' })
  taskId: string;

  @ManyToOne(() => Task)
  @JoinColumn({ name: 'task_id' })
  task: Task;

  @Column({ type: 'varchar' })
  text: string;

  @Column({ type: 'boolean', default: false })
  checked: boolean;

  @Column({ type: 'int', nullable: true })
  position: number | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
