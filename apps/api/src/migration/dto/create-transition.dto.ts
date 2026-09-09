import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { TASK_STATUSES } from '@muneral/types';
import type { TaskStatus } from '@muneral/types';

/** AUP-DAT-003: ONE compare-and-set transition, no Studio and no fleet. */
export class CreateTransitionDto {
  /** The revision the caller believes the work item is at. A mismatch is a
   *  STALE_REVISION conflict carrying the current revision. */
  @IsInt()
  @Min(0)
  expectedRevision: number;

  @IsIn(TASK_STATUSES)
  toStatus: TaskStatus;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  idempotencyKey: string;

  /** Opaque references to evidence held elsewhere; bounded, never inlined. */
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(64)
  @IsOptional()
  evidenceRefs?: string[];

  /** Why the transition was made — recorded on the activity log entry. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  basis: string;
}
