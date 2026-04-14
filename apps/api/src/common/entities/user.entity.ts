import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
} from 'typeorm';
import { WorkspaceMember } from '../../workspaces/entities/workspace-member.entity';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'github_id', type: 'bigint', unique: true, nullable: true })
  githubId: number | null;

  @Column({ name: 'telegram_id', type: 'bigint', unique: true, nullable: true })
  telegramId: number | null;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ name: 'avatar_url', type: 'varchar', nullable: true })
  avatarUrl: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @OneToMany(() => WorkspaceMember, (m) => m.user)
  memberships: WorkspaceMember[];
}
