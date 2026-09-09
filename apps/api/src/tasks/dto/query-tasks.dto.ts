import { IsIn, IsOptional, IsISO8601, IsUUID, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { TaskStatus } from '@muneral/types';

/**
 * Query filter for GET /tasks.
 *
 * Why this exists: every consumer that needed "what finished today" had to
 * either walk the projects one at a time or read a Markdown snapshot off a
 * disk. The assistant's evening digest took the second route, which is how it
 * spent 25 days reporting an August snapshot as today's state — the file feed
 * had been switched off and nothing downstream could tell.
 *
 * `updatedSince` is the field that makes a digest possible without a scan:
 * ask for what moved, not for everything and then filter in the caller.
 */
export class QueryTasksDto {
  @IsOptional()
  @IsIn(['todo', 'in_progress', 'review', 'blocked', 'done', 'cancelled'])
  status?: TaskStatus;

  @IsOptional()
  @IsUUID()
  projectId?: string;

  /** ISO-8601. Returns tasks whose updatedAt is >= this instant. */
  @IsOptional()
  @IsISO8601()
  updatedSince?: string;

  /** ISO-8601. Returns tasks whose updatedAt is < this instant. */
  @IsOptional()
  @IsISO8601()
  updatedBefore?: string;

  /**
   * Bounded on purpose. An unbounded list endpoint over 3k+ rows is a slow
   * query waiting for its first busy day; callers that need more page with
   * `offset` and see `total` to know whether they have it all.
   */
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
