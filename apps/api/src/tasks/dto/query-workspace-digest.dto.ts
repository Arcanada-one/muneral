import { IsIn, IsOptional, IsISO8601, IsUUID, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { TASK_STATUSES, TaskStatus } from '@muneral/types';

/**
 * A2-284 — the filters of `GET /tasks/digest`.
 *
 * Deliberately NOT `QueryTasksDto`, and not a subclass of it. That DTO belongs
 * to the cross-workspace JWT route; sharing it would mean a filter added there
 * later arrives on the agent-key route the day it merges, without anyone
 * choosing it — the same "a route nobody remembers to close" failure the
 * `@AgentScope` allowlist exists to prevent, one level down. The four filters
 * here are the four the measured consumer sends (`arcanada-assistant#76`:
 * `status`, `updatedSince`, `updatedBefore`, `limit`), plus paging and the
 * optional narrowing to a single project.
 *
 * `contractDigest` is absent on purpose: no digest renders it, and an unused
 * filter is one more way to ask the database a question from a key.
 */
export class QueryWorkspaceDigestDto {
  /** Imported, never restated — `archived` is a real status and a digest that
   *  could not ask for it would have to scan for it. */
  @IsOptional()
  @IsIn(TASK_STATUSES)
  status?: TaskStatus;

  /**
   * Narrows to one project. A project of ANOTHER workspace is not an error and
   * not a refusal: the workspace filter still applies, so the answer is an
   * empty page. A refusal here would tell a key whether a project id it
   * guessed exists somewhere else.
   */
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

  /** Same ceiling as `QueryTasksDto`: a caller that needs more pages with
   *  `offset` and sees `total` to know whether it has it all. */
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
