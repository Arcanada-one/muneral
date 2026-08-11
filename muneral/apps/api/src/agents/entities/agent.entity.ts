import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Workspace } from '../../workspaces/entities/workspace.entity';

@Entity('agents')
export class Agent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'workspace_id', type: 'uuid' })
  workspaceId: string;

  @ManyToOne(() => Workspace)
  @JoinColumn({ name: 'workspace_id' })
  workspace: Workspace;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'varchar', nullable: true })
  model: string | null;

  @Column({ type: 'varchar', nullable: true })
  provider: string | null;

  @Column({ type: 'jsonb', default: '{}' })
  capabilities: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
