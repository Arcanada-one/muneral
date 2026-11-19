import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Query for GET /tasks/:taskId/activity.
 *
 * Upper bound is the real web client page size, not a guessed ceiling:
 * - apps/web/lib/api/tasks.ts:170 — `TASK_ACTIVITY_PAGE_LIMIT = 20`
 * - apps/web/e2e/activity-visible-count/synthetic-api-client.mjs:1 — `PAGE_LIMIT = 20`
 * - AuditLog fixtures / TaskDetail mocks request `limit=20`
 *
 * Without @Max, `parseInt(limit)` was taken as Prisma `take` unbounded
 * (tasks.controller.ts previously; activity.service.ts `take: limit`).
 */
export const TASK_ACTIVITY_MAX_LIMIT = 20;

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
  limit?: number = TASK_ACTIVITY_MAX_LIMIT;
}
