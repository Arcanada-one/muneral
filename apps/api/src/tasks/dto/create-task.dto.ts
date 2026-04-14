import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsIn,
  IsUUID,
  IsNumber,
  IsDateString,
  MaxLength,
  IsArray,
} from 'class-validator';
import { TaskStatus, TaskPriority } from '@muneral/types';

export class CreateTaskDto {
  @IsUUID()
  projectId: string;

  @IsUUID()
  @IsOptional()
  sprintId?: string;

  @IsUUID()
  @IsOptional()
  parentId?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  title: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsIn(['todo', 'in_progress', 'review', 'blocked', 'done', 'cancelled'])
  @IsOptional()
  status?: TaskStatus;

  @IsIn(['critical', 'high', 'medium', 'low'])
  @IsOptional()
  priority?: TaskPriority;

  @IsDateString()
  @IsOptional()
  dueDate?: string;

  @IsNumber()
  @IsOptional()
  estimateHours?: number;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];
}
