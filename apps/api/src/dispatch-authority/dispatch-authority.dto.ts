import {
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { TASK_STATUSES } from '@muneral/types';
import type { TaskStatus } from '@muneral/types';

export class IssueDispatchDto {
  @IsInt()
  @Min(0)
  expectedTaskRevision!: number;

  @IsIn(TASK_STATUSES)
  expectedTaskStatus!: TaskStatus;

  @IsDateString()
  expectedTaskUpdatedAt!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9._:-]{16,128}$/)
  idempotencyKey!: string;

  @IsObject()
  request!: Record<string, unknown>;

  @IsObject()
  executionContext!: Record<string, unknown>;
}

/** This is only a lookup reference. It is not proof that a terminal exists or
 * belongs to a trusted runtime; the configured authority adapter must verify it.
 */
export class BindTerminalDispatchDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  @Matches(/^[A-Za-z0-9._:-]+$/)
  terminalDeclarationId!: string;
}
