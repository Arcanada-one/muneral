import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
} from 'typeorm';
import { Project } from '../../projects/entities/project.entity';
import { Sprint } from '../../milestones/entities/sprint.entity';
import { TaskStatus, TaskPriority, ActorType } from '@muneral/types';

@Entity('tasks')
export class Task {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId: string;

  @ManyToOne(() => Project, (p) => p.tasks)
  @JoinColumn({ name: 'project_id' })
  project: Project;

  @Column({ name: 'sprint_id', type: 'uuid', nullable: true })
  sprintId: string | null;

  @ManyToOne(() => Sprint, { nullable: true })
  @JoinColumn({ name: 'sprint_id' })
  sprint: Sprint | null;

  @Column({ name: 'parent_id', type: 'uuid', nullable: true })
  parentId: string | null;

  @ManyToOne(() => Task, (t) => t.subtasks, { nullable: true })
  @JoinColumn({ name: 'parent_id' })
  parent: Task | null;

  @OneToMany(() => Task, (t) => t.parent)
  subtasks: Task[];

  @Column({ type: 'varchar' })
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'varchar', default: 'todo' })
  status: TaskStatus;

  @Column({ type: 'varchar', default: 'medium' })
  priority: TaskPriority;

  @Column({ name: 'due_date', type: 'date', nullable: true })
  dueDate: string | null;

  @Column({
    name: 'estimate_hours',
    type: 'numeric',
    precision: 6,
    scale: 2,
    nullable: true,
  })
  estimateHours: number | null;

  @Column({ name: 'created_by_id', type: 'uuid', nullable: true })
  createdById: string | null;

  @Column({ name: 'actor_type', type: 'varchar', nullable: true })
  actorType: ActorType | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
