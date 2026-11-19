import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Query for GET /tasks/:taskId/activity.
 *
 * Default page size matches the web UI page size:
 * - apps/web/lib/api/tasks.ts — `TASK_ACTIVITY_PAGE_LIMIT = 20`
 * - apps/web/e2e/activity-visible-count/synthetic-api-client.mjs:1 — `PAGE_LIMIT = 20`
 *
 * Upper bound matches real API clients that read full task history in one page:
 * Root orchestration tooling calls `GET /tasks/{id}/activity?limit=500`.
 *
 * Without @Max, `parseInt(limit)` was taken as Prisma `take` unbounded
 * (tasks.controller.ts previously; activity.service.ts `take: limit`).
 */
export const TASK_ACTIVITY_DEFAULT_LIMIT = 20;
export const TASK_ACTIVITY_MAX_LIMIT = 500;

export class QueryTaskActivityDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(TASK_ACTIVITY_MAX_LIMIT)
  limit?: number = TASK_ACTIVITY_DEFAULT_LIMIT;
}
