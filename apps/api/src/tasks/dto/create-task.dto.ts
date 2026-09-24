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
  Matches,
} from 'class-validator';
import { TASK_STATUSES } from '@muneral/types';
import type { TaskStatus, TaskPriority } from '@muneral/types';

/**
 * A2-267 — the only shape a KC2 contract digest takes: the algorithm prefix and
 * 64 LOWERCASE hex digits, exactly what Argana's `is_wellformed_digest` accepts
 * (src/argana/intake.py). Anchored at both ends; uppercase is refused rather
 * than normalised, because a digest compared byte-for-byte must be stored in
 * the one spelling it is compared in. The database CHECK
 * `tasks_contract_digest_format` holds the same pattern for writers that do
 * not come through this DTO.
 */
export const CONTRACT_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

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

  @IsIn(TASK_STATUSES)
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

  /**
   * A2-267 — the KC2 contract digest this work item executes. A first-class
   * field so an executing agent can fetch the exact contract; before it the
   * digest could only travel as a line inside `description`, because this DTO
   * refused any undeclared property with 400. Optional: most tasks have no
   * contract. `null` is accepted and means the same as absent.
   */
  @IsOptional()
  @IsString()
  contractDigest?: string | null;
}
