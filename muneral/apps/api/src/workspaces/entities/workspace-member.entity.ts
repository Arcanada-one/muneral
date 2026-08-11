import { Entity, PrimaryColumn, Column, ManyToOne, JoinColumn } from 'typeorm';
import { User } from '../../common/entities/user.entity';
import { Workspace } from './workspace.entity';
import { WorkspaceMemberRole } from '@muneral/types';

@Entity('workspace_members')
export class WorkspaceMember {
  @PrimaryColumn({ name: 'workspace_id', type: 'uuid' })
  workspaceId: string;

  @PrimaryColumn({ name: 'user_id', type: 'uuid' })
  userId: string;

  @ManyToOne(() => Workspace, (w) => w.members)
  @JoinColumn({ name: 'workspace_id' })
  workspace: Workspace;

  @ManyToOne(() => User, (u) => u.memberships)
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({
    type: 'varchar',
    enum: ['owner', 'manager', 'developer', 'viewer'],
  })
  role: WorkspaceMemberRole;
}
