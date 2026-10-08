import { IsIn, IsOptional, IsISO8601, IsInt, Matches, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { TASK_STATUSES, TaskStatus } from '@muneral/types';

/** The page ceiling of a filtered index read; the unfiltered read is unpaged, as before. */
export const PROJECT_INDEX_MAX_LIMIT = 500;

/**
 * DEC-AUP-0134 — the optional filters of `GET /tasks/project/:projectId/index`.
 *
 * They can only NARROW the rows an unfiltered call already returns, and they
 * change no authorisation: the guard has already decided, from the path, whether
 * this key may read this project. Hence there is deliberately NO `projectId`
 * field here — the project comes from the path alone, and `whitelist: true`
 * strips a stray `?projectId=` before the handler sees it. No free-text filter
 * either (no title, no description): filtering on text would let a key probe
 * the text it is not given.
 */
export class QueryProjectIndexDto {
  @IsOptional()
  @IsIn(TASK_STATUSES)
  status?: TaskStatus;

  /** ISO-8601. Rows whose updatedAt is >= this instant. */
  @IsOptional()
  @IsISO8601()
  updatedSince?: string;

  /** ISO-8601. Rows whose updatedAt is < this instant. */
  @IsOptional()
  @IsISO8601()
  updatedBefore?: string;

  /** `sha256:<64 lowercase hex>`, the format `tasks_contract_digest_format` enforces. */
  @IsOptional()
  @Matches(/^sha256:[0-9a-f]{64}$/)
  contractDigest?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PROJECT_INDEX_MAX_LIMIT)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
