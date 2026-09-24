import { IsIn, IsOptional, IsISO8601, IsUUID, IsInt, Min, Max, Matches } from 'class-validator';
import { Type } from 'class-transformer';
import { TASK_STATUSES, TaskStatus } from '@muneral/types';
import { CONTRACT_DIGEST_PATTERN } from './create-task.dto.js';

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
  // Imported, never restated. My first draft hard-coded the six statuses I
  // happened to know and silently omitted `archived` — so a query for archived
  // work would have been rejected as an invalid status. TASK_STATUSES exists
  // precisely because MUN-0043 found the same list hard-coded in three DTOs.
  @IsOptional()
  @IsIn(TASK_STATUSES)
  status?: TaskStatus;

  @IsOptional()
  @IsUUID()
  projectId?: string;

  /**
   * A2-267 — the work items admitted under one KC2 contract. Exact match on the
   * stored spelling; a malformed digest is a 400, not an empty page, so a typo
   * cannot read as "no work item carries this contract".
   */
  @IsOptional()
  @Matches(CONTRACT_DIGEST_PATTERN, {
    message: 'contractDigest must be sha256: followed by 64 lowercase hex digits',
  })
  contractDigest?: string;

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
