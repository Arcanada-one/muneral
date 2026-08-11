import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Project } from '../../projects/entities/project.entity';

@Entity('milestones')
export class Milestone {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId: string;

  @ManyToOne(() => Project)
  @JoinColumn({ name: 'project_id' })
  project: Project;

  @Column({ type: 'varchar' })
  title: string;

  @Column({ name: 'due_date', type: 'date', nullable: true })
  dueDate: string | null;

  @Column({ type: 'varchar', default: 'open' })
  status: string;
}
