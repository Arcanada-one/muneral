import {
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsUUID,
  ValidateIf,
} from 'class-validator';
import type { TaskPriority } from '@muneral/types';

/**
 * MUN-0077 — agent-safe metadata body for `PATCH /tasks/:taskId`.
 *
 * Whitelist only. Global `forbidNonWhitelisted` refuses title, description,
 * status, projectId, parentId, contractDigest, tags and any other property
 * before the handler runs. Status moves stay on `PATCH .../status`.
 */
export class UpdateTaskMetadataDto {
  @IsOptional()
  @IsIn(['critical', 'high', 'medium', 'low'])
  priority?: TaskPriority;

  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsDateString()
  dueDate?: string | null;

  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsNumber()
  estimateHours?: number | null;

  @IsOptional()
  @ValidateIf((_object, value) => value !== null)
  @IsUUID()
  sprintId?: string | null;
}
