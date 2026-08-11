import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
} from 'typeorm';
import { Workspace } from '../../workspaces/entities/workspace.entity';
import { Task } from '../../tasks/entities/task.entity';

@Entity('projects')
export class Project {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'workspace_id', type: 'uuid' })
  workspaceId: string;

  @ManyToOne(() => Workspace)
  @JoinColumn({ name: 'workspace_id' })
  workspace: Workspace;

  @Column({ type: 'varchar' })
  slug: string;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ name: 'repo_url', type: 'varchar', nullable: true })
  repoUrl: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @OneToMany(() => Task, (t) => t.project)
  tasks: Task[];
}
