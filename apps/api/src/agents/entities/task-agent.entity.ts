import {
  Entity,
  PrimaryColumn,
  Column,
  ManyToOne,
  JoinColumn,
  CreateDateColumn,
} from 'typeorm';
import { Task } from '../../tasks/entities/task.entity';
import { Agent } from './agent.entity';
import { TaskAgentRole } from '@muneral/types';

@Entity('task_agents')
export class TaskAgent {
  @PrimaryColumn({ name: 'task_id', type: 'uuid' })
  taskId: string;

  @PrimaryColumn({ name: 'agent_id', type: 'uuid' })
  agentId: string;

  @ManyToOne(() => Task)
  @JoinColumn({ name: 'task_id' })
  task: Task;

  @ManyToOne(() => Agent)
  @JoinColumn({ name: 'agent_id' })
  agent: Agent;

  @Column({ type: 'varchar', enum: ['lead', 'reviewer', 'executor'] })
  role: TaskAgentRole;

  @CreateDateColumn({ name: 'assigned_at' })
  assignedAt: Date;
}
