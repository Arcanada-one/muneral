import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { BadRequestException } from '@nestjs/common';

/**
 * Query for GET /tasks/:taskId/activity.
 *
 * - `page`: integer 1..TASK_ACTIVITY_MAX_PAGE, default 1. The maximum keeps the
 *   row offset `(page - 1) * limit` within Number.MAX_SAFE_INTEGER for every
 *   allowed limit.
 * - `limit`: integer 1..TASK_ACTIVITY_MAX_LIMIT, default TASK_ACTIVITY_DEFAULT_LIMIT.
 *   The default equals the web UI page size (apps/web/lib/api/tasks.ts
 *   `TASK_ACTIVITY_PAGE_LIMIT`); the maximum lets a client read a long task
 *   history in one page.
 * - Any other query parameter name is refused with 400
 *   (`assertActivityQueryKeys`).
 */
export const TASK_ACTIVITY_DEFAULT_LIMIT = 20;
export const TASK_ACTIVITY_MAX_LIMIT = 500;
export const TASK_ACTIVITY_MAX_PAGE = Math.floor(Number.MAX_SAFE_INTEGER / TASK_ACTIVITY_MAX_LIMIT);

export class QueryTaskActivityDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(TASK_ACTIVITY_MAX_PAGE)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(TASK_ACTIVITY_MAX_LIMIT)
  limit?: number = TASK_ACTIVITY_DEFAULT_LIMIT;
}

/** The only query parameter names GET /tasks/:taskId/activity accepts. */
export const TASK_ACTIVITY_QUERY_KEYS: readonly string[] = ['page', 'limit'];

/**
 * Refuses any query parameter name outside TASK_ACTIVITY_QUERY_KEYS, read from
 * the raw request URL rather than the parsed query object, because the DTO
 * whitelist does not refuse names that match Object.prototype members
 * (`__proto__`, `constructor`, `toString` and others).
 */
export function assertActivityQueryKeys(url: string): void {
  const at = url.indexOf('?');
  if (at < 0) return;
  const unknown = new Set<string>();
  for (const key of new URLSearchParams(url.slice(at + 1)).keys()) {
    if (!TASK_ACTIVITY_QUERY_KEYS.includes(key)) unknown.add(key);
  }
  if (unknown.size > 0) {
    throw new BadRequestException([...unknown].map((key) => `property ${key} should not exist`));
  }
}
