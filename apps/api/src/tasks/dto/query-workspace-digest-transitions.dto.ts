import {
  IsOptional,
  IsISO8601,
  IsUUID,
  IsInt,
  Min,
  Max,
  IsBooleanString,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * MUN-0069 — filters for `GET /tasks/digest/transitions`.
 *
 * Separate from `QueryWorkspaceDigestDto`: that DTO filters the task-row list
 * by `updatedAt`. This one asks for a half-open activity window over
 * `task:status_changed` only. Sharing the DTO would let an `updatedAt` filter
 * silently become a transition filter (or the reverse) on a later edit.
 */
export class QueryWorkspaceDigestTransitionsDto {
  /** Inclusive start of the half-open UTC window over activity.createdAt. */
  @IsISO8601()
  sinceInclusive!: string;

  /** Exclusive end of the half-open UTC window over activity.createdAt. */
  @IsISO8601()
  beforeExclusive!: string;

  /**
   * Narrows to one project. A project of another workspace yields an empty
   * page (workspace predicate still applies) — never a cross-tenant leak.
   */
  @IsOptional()
  @IsUUID()
  projectId?: string;

  /**
   * When "true", attach a bodyless current-status histogram for the same
   * workspace (or project) scope. Separate from transition counts and from
   * age crossings.
   */
  @IsOptional()
  @IsBooleanString()
  includeStatusHistogram?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
