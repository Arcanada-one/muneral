import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateTaskDto } from './dto/create-task.dto.js';
import { UpdateTaskStatusDto } from './dto/update-task-status.dto.js';
import { QueryTasksDto } from './dto/query-tasks.dto.js';
import { AddDependencyDto } from './dto/add-dependency.dto.js';
import { CreateChecklistItemDto } from './dto/create-checklist-item.dto.js';
import { ActivityService } from '../activity/activity.service.js';
import { KanbanService } from '../ws/kanban.service.js';
import { createHash, randomUUID } from 'node:crypto';
import { isValidTransition } from '@muneral/types';
import type { Actor, TaskStatus } from '@muneral/types';
import { TaskFieldStateService } from './field-state/task-field-state.service.js';
import { TaskExecutionRecorderService } from '../execution-authority/task-execution-recorder.service.js';
import { agentOwnTaskWhere } from '../auth/agent-task-visibility.js';
import type { ProjectReadGrantEntry } from '../auth/project-read-grants.js';
import { renewalDueAt } from '../auth/project-read-grants.js';
import type { WorkspaceDigestGrantEntry } from '../auth/workspace-digest-grants.js';
import { digestRenewalDueAt } from '../auth/workspace-digest-grants.js';
import { QueryWorkspaceDigestDto } from './dto/query-workspace-digest.dto.js';

/** MUN-0052: the activity action one task-index read records. */
export const PROJECT_INDEX_READ_ACTION = 'project:index_read';

/** MUN-0052: what the index's `total` counts, stated in the answer (I4). */
export const PROJECT_INDEX_COUNTED =
  'every task of the project, all statuses including cancelled and archived';

/** A2-284: the activity action one workspace-digest read records. */
export const WORKSPACE_DIGEST_READ_ACTION = 'workspace:digest_read';

/** A2-284: what the digest's `total` counts, stated in the answer — the count
 *  is BEFORE paging, so an empty page and an empty workspace are different
 *  answers rather than the same one. */
export const WORKSPACE_DIGEST_COUNTED =
  "every task of the key's own workspace matching the filters, before paging";

/**
 * A2-284: the only task columns `GET /tasks/digest` returns.
 *
 * An allowlist in the SELECT, not a strip after the read: a column added to
 * `tasks` later does not reach an agent key by default, which is the same
 * direction `@AgentScope` takes for routes. These seven are what the measured
 * consumer renders (`arcanada-assistant#76` — `MuneraTaskSchema` requires id,
 * projectId, title, status, createdAt, updatedAt and reads priority).
 *
 * What is NOT here and why: `description` (free text the digest never prints),
 * `createdById` / `actorType` (who did what is the activity log's question),
 * `bootstrapStamp`, `importedAt`, `revision`, `contractDigest`, `sprintId`,
 * `parentId`, `dueDate`, `estimateHours` — none is rendered, and every one of
 * them would be a fact about the board this key did not need.
 *
 * There is no `completedAt` to return: measured on this schema (2026-09-24),
 * `tasks` carries `createdAt` and `updatedAt` only. "Completed today" is
 * therefore `status=done` AND `updatedAt` inside the day — which is what the
 * consumer already asks for, and what its own comment records as
 * over-reporting exactly the case of a done task edited later the same day.
 */
const WORKSPACE_DIGEST_SELECT = {
  id: true,
  projectId: true,
  title: true,
  status: true,
  priority: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.TaskSelect;

/** MUN-0052: the only task columns the index returns (DEC-AUP-0029 R3). The
 *  title leaves as a hash; description, bootstrap stamp, creator id, import
 *  provenance and revision never leave at all. */
const PROJECT_INDEX_SELECT = {
  id: true,
  parentId: true,
  status: true,
  priority: true,
  actorType: true,
  createdAt: true,
  updatedAt: true,
  title: true,
} satisfies Prisma.TaskSelect;

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activityService: ActivityService,
    private readonly kanbanService: KanbanService,
    private readonly fieldStateService: TaskFieldStateService,
    private readonly executionRecorder: TaskExecutionRecorderService,
  ) {}

  async create(actor: Actor, dto: CreateTaskDto) {
    const project = await this.prisma.project.findUnique({
      where: { id: dto.projectId },
    });
    if (!project) {
      throw new NotFoundException('Project not found');
    }

    // All mutations (task create + field-state + activity) in one transaction.
    // kanbanService.notify is post-commit (side-effect outside tx).
    const task = await this.prisma.$transaction(
      async (tx) => {
        const created = await tx.task.create({
          data: {
            projectId: dto.projectId,
            sprintId: dto.sprintId ?? null,
            parentId: dto.parentId ?? null,
            title: dto.title,
            description: dto.description ?? null,
            status: dto.status ?? 'todo',
            priority: dto.priority ?? 'medium',
            dueDate: dto.dueDate ?? null,
            estimateHours:
              dto.estimateHours != null
                ? new Prisma.Decimal(dto.estimateHours)
                : null,
            contractDigest: dto.contractDigest ?? null,
            createdById: actor.id,
            actorType: actor.type,
          },
        });

        // Save tags
        if (dto.tags?.length) {
          await tx.taskTag.createMany({
            data: dto.tags.map((tag) => ({ taskId: created.id, tag })),
          });
        }

        // Recompute field state using resolved entity (not DTO — defaults applied above)
        await this.fieldStateService.recompute(tx, created);

        await tx.activityLog.create({
          data: {
            workspaceId: project.workspaceId,
            taskId: created.id,
            actorType: actor.type,
            actorId: actor.id,
            action: 'task:created',
            payload: { title: created.title, status: created.status } as Prisma.InputJsonValue,
          },
        });

        return created;
      },
      { timeout: 10_000, isolationLevel: 'ReadCommitted' },
    );

    this.kanbanService.notify(project.id, 'task:created', task);

    // MUN-0040: additive — a task created directly in `in_progress` starts an
    // execution attempt too. Best-effort, never blocks the response.
    if (task.status === 'in_progress') {
      await this.executionRecorder.onStatusTransition(
        task.id,
        'in_progress',
        randomUUID(),
      );
    }

    return task;
  }

  async findOne(taskId: string) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task) {
      throw new NotFoundException('Task not found');
    }
    return task;
  }

  /**
   * Tasks in a project.
   *
   * MUN-0043: when `scopedToAgentId` is given the answer is narrowed to the
   * tasks that agent is assigned to — or, since MUN-0051, created (see
   * agentOwnTaskWhere). The parameter is the agent resolved from
   * an API key by `AgentTaskScopeGuard`; a JWT caller passes nothing and the
   * behaviour is unchanged. Narrowing lives here rather than in the controller
   * so the database, not a post-filter, is what never returns the other rows.
   */
  async findByProject(projectId: string, scopedToAgentId?: string) {
    return this.prisma.task.findMany({
      where: {
        projectId,
        ...(scopedToAgentId ? agentOwnTaskWhere(scopedToAgentId) : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * MUN-0052 — the task index of a project, for an agent key holding a read
   * grant (`@AgentScope('project-index')`, DEC-AUP-0029).
   *
   * Every task of the project, every status (cancelled and archived included),
   * as ids, status and a sha256 of the title — enough to count and reconcile a
   * board, not enough to read it. The query selects the title only to hash it;
   * the plain title is never put in the answer.
   *
   * Each read writes one activity row naming the agent, the project, the
   * decision and the row count BEFORE it answers, and the answer carries that
   * row's id: a caller's receipt can prove one logged event per read without a
   * database read path. A read whose row cannot be written fails.
   */
  async indexForProject(
    projectId: string,
    agentId: string,
    grant: ProjectReadGrantEntry,
  ) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { workspaceId: true },
    });
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found.`);
    }

    const rows = await this.prisma.task.findMany({
      where: { projectId },
      select: PROJECT_INDEX_SELECT,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const tasks = rows.map(({ title, ...rest }) => ({
      ...rest,
      titleSha256: createHash('sha256').update(title, 'utf8').digest('hex'),
    }));

    const audit = await this.prisma.activityLog.create({
      data: {
        workspaceId: project.workspaceId,
        taskId: null,
        actorType: 'agent',
        actorId: agentId,
        action: PROJECT_INDEX_READ_ACTION,
        payload: {
          projectId,
          decision: grant.decision,
          rowCount: tasks.length,
        } as Prisma.InputJsonValue,
      },
      select: { id: true, createdAt: true },
    });
    // Read back from the same table: how many index reads this agent has on
    // record in the workspace, this one included. A caller comparing two
    // answers sees the rows persist without any other route to the log.
    const auditReadCount = await this.prisma.activityLog.count({
      where: { workspaceId: project.workspaceId, actorId: agentId, action: PROJECT_INDEX_READ_ACTION },
    });

    return {
      projectId,
      counted: PROJECT_INDEX_COUNTED,
      total: tasks.length,
      generatedAt: audit.createdAt.toISOString(),
      auditEventId: audit.id,
      auditReadCount,
      // MUN-0055 (DEC-AUP-0033 R3): `renewalDueAt` is how a lapse becomes
      // visible BEFORE it happens. The first grant went quiet at its `until`
      // and nothing noticed for two days; every caller already writes this
      // envelope into a receipt, so the warning rides the read it already does
      // rather than needing a watcher nobody would run.
      grant: {
        decision: grant.decision,
        until: grant.until,
        renewalDueAt: renewalDueAt(grant),
      },
      tasks,
    };
  }

  /**
   * A2-284 — the workspace task digest for an agent key holding a grant
   * (`@AgentScope('workspace-digest')`).
   *
   * Why this route exists at all: `GET /tasks` answers a `mun_sk_` key 403
   * (unmarked route, MUN-0043) while its own DTO names the assistant's digest
   * as the consumer it was built for, and the one route a key COULD reach —
   * `GET /tasks/project/:id` — answered `[]` on a board of 880+ rows because
   * the key owns none of them. Measured live 2026-09-24, A2-281. An authorised,
   * well-formed, completely empty answer is worse than the 403: nothing about
   * it looks wrong.
   *
   * Why a route of its own rather than `@AgentScope` on `GET /tasks`:
   * `query()` above has no workspace narrowing at all, by design, so scoping it
   * would mean a conditional narrowing whose DEFAULT is every workspace — one
   * forgotten branch away from a cross-tenant list. Here the workspace is a
   * required parameter of the only method the route calls, ANDed into the where
   * clause below; there is no argument list that answers unscoped. The cost is
   * named in `docs/agent-workspace-digest.md`: the consumer changes one path.
   *
   * Each read writes one activity row naming the agent, the decision and the
   * row count before it answers, and the answer carries that row's id — the
   * same receipt discipline as the project index (MUN-0052). A read whose row
   * cannot be written fails.
   */
  async digestForWorkspace(
    workspaceId: string,
    agentId: string,
    grant: WorkspaceDigestGrantEntry,
    dto: QueryWorkspaceDigestDto,
  ) {
    const limit = dto.limit ?? 50;
    const offset = dto.offset ?? 0;

    // The workspace filter is written FIRST and never from the dto: the caller
    // supplies filters, not scope. `projectId` below can only narrow inside it
    // — a project of another workspace yields an empty page, not a refusal and
    // not somebody else's board.
    const where: Prisma.TaskWhereInput = { project: { workspaceId } };
    if (dto.status) where.status = dto.status;
    if (dto.projectId) where.projectId = dto.projectId;
    if (dto.updatedSince || dto.updatedBefore) {
      where.updatedAt = {
        ...(dto.updatedSince ? { gte: new Date(dto.updatedSince) } : {}),
        ...(dto.updatedBefore ? { lt: new Date(dto.updatedBefore) } : {}),
      };
    }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.task.findMany({
        where,
        select: WORKSPACE_DIGEST_SELECT,
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        take: limit,
        skip: offset,
      }),
      this.prisma.task.count({ where }),
    ]);

    const audit = await this.prisma.activityLog.create({
      data: {
        workspaceId,
        taskId: null,
        actorType: 'agent',
        actorId: agentId,
        action: WORKSPACE_DIGEST_READ_ACTION,
        payload: {
          decision: grant.decision,
          rowCount: items.length,
          total,
          // The filters, not the rows: what was asked is the part an auditor
          // cannot reconstruct afterwards. Free text never enters the log
          // because no filter here carries any.
          filters: {
            status: dto.status ?? null,
            projectId: dto.projectId ?? null,
            updatedSince: dto.updatedSince ?? null,
            updatedBefore: dto.updatedBefore ?? null,
            limit,
            offset,
          },
        } as Prisma.InputJsonValue,
      },
      select: { id: true, createdAt: true },
    });

    return {
      // The first four keys, in this order, are the envelope `GET /tasks`
      // already answers, so a consumer moving to this route changes its path
      // and nothing else.
      items,
      total,
      limit,
      offset,
      counted: WORKSPACE_DIGEST_COUNTED,
      generatedAt: audit.createdAt.toISOString(),
      auditEventId: audit.id,
      // The lapse warning rides the read the consumer already does — see
      // workspace-digest-grants.ts on the two days of silence that cost.
      grant: {
        decision: grant.decision,
        until: grant.until,
        renewalDueAt: digestRenewalDueAt(grant),
      },
    };
  }

  /**
   * Filtered task query across projects.
   *
   * Until this existed the only listing was findByProject, so a consumer that
   * wanted "everything that reached done today" had to enumerate projects and
   * merge the results — correct only for as long as it remembered to add the
   * next project. The assistant's digest took the other way out and read a
   * Markdown snapshot from disk instead; when that file feed was switched off
   * on 2026-08-14 the digest kept publishing the stale snapshot for 25 days.
   * A consumer should not have to choose between a scan and a stale file.
   *
   * Access is deliberately no wider than findByProject already is: the auth
   * guard on this controller authenticates but does not scope by workspace,
   * and widening that is a separate change with its own review — not something
   * to slip in under a new query parameter.
   *
   * Returns `total` alongside the page so a caller can tell "nothing matched"
   * apart from "the first page happened to be empty" — an empty list with no
   * count is exactly the shape that reads as a clean bill of health.
   */
  async query(dto: QueryTasksDto) {
    const limit = dto.limit ?? 50;
    const offset = dto.offset ?? 0;

    const where: Prisma.TaskWhereInput = {};
    if (dto.status) where.status = dto.status;
    if (dto.projectId) where.projectId = dto.projectId;
    if (dto.contractDigest) where.contractDigest = dto.contractDigest;
    if (dto.updatedSince || dto.updatedBefore) {
      where.updatedAt = {
        ...(dto.updatedSince ? { gte: new Date(dto.updatedSince) } : {}),
        ...(dto.updatedBefore ? { lt: new Date(dto.updatedBefore) } : {}),
      };
    }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.task.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.task.count({ where }),
    ]);

    return { items, total, limit, offset };
  }

  async updateStatus(
    taskId: string,
    actor: Actor,
    dto: UpdateTaskStatusDto,
  ) {
    const task = await this.findOne(taskId);
    const project = await this.prisma.project.findUnique({
      where: { id: task.projectId },
    });
    if (!project) {
      throw new NotFoundException('Project not found');
    }

    // MUN-0054: a repeat of a move already made is not a transition and not a
    // fault. The map has no self-edges (`todo → todo` is "invalid"), which
    // answered 400 to an unattended caller retrying after a lost response —
    // and a 400 it could not distinguish from a real refusal. Answer 200 with
    // the task as it is and `idempotent: true`, and write NOTHING: no task
    // update, no field-state recompute (the ETag must not move), no activity
    // row (the log would claim a move that did not happen), no kanban event,
    // and no execution-authority recording (a second `in_progress` would open
    // or misattribute an attempt — see TaskExecutionRecorderService).
    if (task.status === dto.status) {
      return { ...task, idempotent: true };
    }

    if (!isValidTransition(task.status as TaskStatus, dto.status)) {
      throw new BadRequestException(
        `Invalid status transition: ${task.status} → ${dto.status}`,
      );
    }

    const previousStatus = task.status;

    const updated = await this.prisma.$transaction(
      async (tx) => {
        const u = await tx.task.update({
          where: { id: taskId },
          data: { status: dto.status },
        });

        await this.fieldStateService.recompute(tx, u);

        await tx.activityLog.create({
          data: {
            workspaceId: project.workspaceId,
            taskId: task.id,
            actorType: actor.type,
            actorId: actor.id,
            action: 'task:status_changed',
            payload: { from: previousStatus, to: dto.status } as Prisma.InputJsonValue,
          },
        });

        return u;
      },
      { timeout: 10_000, isolationLevel: 'ReadCommitted' },
    );

    this.kanbanService.notify(project.id, 'task:moved', {
      taskId: task.id,
      from: previousStatus,
      to: dto.status,
    });

    // MUN-0040: record the execution attempt this transition implies.
    // Additive and best-effort — see TaskExecutionRecorderService header for
    // why a recording failure must never fail the status transition itself.
    await this.executionRecorder.onStatusTransition(
      task.id,
      dto.status,
      randomUUID(),
    );

    return updated;
  }

  async update(
    taskId: string,
    actor: Actor,
    updates: Partial<{
      title: string;
      description: string | null;
      priority: string;
      dueDate: string | null;
      estimateHours: number | null;
      sprintId: string | null;
    }>,
  ) {
    const task = await this.findOne(taskId);
    const project = await this.prisma.project.findUnique({
      where: { id: task.projectId },
    });

    const data: Prisma.TaskUncheckedUpdateInput = {};
    if (updates.title !== undefined) data.title = updates.title;
    if (updates.description !== undefined) data.description = updates.description;
    if (updates.priority !== undefined) data.priority = updates.priority;
    if (updates.dueDate !== undefined) data.dueDate = updates.dueDate;
    if (updates.estimateHours !== undefined) {
      data.estimateHours =
        updates.estimateHours != null
          ? new Prisma.Decimal(updates.estimateHours)
          : null;
    }
    if (updates.sprintId !== undefined) data.sprintId = updates.sprintId;

    const updated = await this.prisma.$transaction(
      async (tx) => {
        const u = await tx.task.update({ where: { id: taskId }, data });

        await this.fieldStateService.recompute(tx, u);

        if (project) {
          await tx.activityLog.create({
            data: {
              workspaceId: project.workspaceId,
              taskId: task.id,
              actorType: actor.type,
              actorId: actor.id,
              action: 'task:updated',
              payload: updates as Prisma.InputJsonValue,
            },
          });
        }

        return u;
      },
      { timeout: 10_000, isolationLevel: 'ReadCommitted' },
    );

    if (project) {
      this.kanbanService.notify(project.id, 'task:updated', updated);
    }

    return updated;
  }

  async delete(taskId: string, actor: Actor): Promise<void> {
    const task = await this.findOne(taskId);
    const project = await this.prisma.project.findUnique({
      where: { id: task.projectId },
    });

    // MUN-0040: a task that ever entered `in_progress` now has a
    // task_execution_state row, and that FK is deliberately `onDelete:
    // Restrict` (schema comment: append-only journal) — this is the DB
    // protecting the execution audit trail from disappearing under a task
    // delete, not something to route around. Surface it as a clear 409
    // instead of letting the raw Prisma P2003 through as an opaque 500.
    try {
      await this.prisma.task.delete({ where: { id: taskId } });
    } catch (err) {
      if (isForeignKeyRestrictViolation(err)) {
        throw new ConflictException(
          'Task has recorded execution history and cannot be deleted',
        );
      }
      throw err;
    }

    if (project) {
      await this.activityService.log({
        workspaceId: project.workspaceId,
        taskId,
        actor,
        action: 'task:deleted',
        payload: { title: task.title },
      });
      this.kanbanService.notify(project.id, 'task:deleted', { taskId });
    }
  }

  // --- Checklist ---

  async addChecklistItem(taskId: string, dto: CreateChecklistItemDto) {
    await this.findOne(taskId); // verify task exists
    return this.prisma.taskChecklist.create({
      data: {
        taskId,
        text: dto.text,
        position: dto.position ?? null,
      },
    });
  }

  async toggleChecklistItem(taskId: string, itemId: string, checked: boolean) {
    const item = await this.prisma.taskChecklist.findFirst({
      where: { id: itemId, taskId },
    });
    if (!item) {
      throw new NotFoundException('Checklist item not found');
    }
    return this.prisma.taskChecklist.update({
      where: { id: itemId },
      data: { checked },
    });
  }

  async deleteChecklistItem(taskId: string, itemId: string): Promise<void> {
    const item = await this.prisma.taskChecklist.findFirst({
      where: { id: itemId, taskId },
    });
    if (!item) {
      throw new NotFoundException('Checklist item not found');
    }
    await this.prisma.taskChecklist.delete({ where: { id: itemId } });
  }

  async getChecklist(taskId: string) {
    return this.prisma.taskChecklist.findMany({
      where: { taskId },
      orderBy: { position: { sort: 'asc', nulls: 'last' } },
    });
  }

  // --- Dependencies ---

  async addDependency(fromTaskId: string, dto: AddDependencyDto) {
    await this.findOne(fromTaskId);
    await this.findOne(dto.toTaskId);

    return this.prisma.taskDependency.create({
      data: {
        fromTaskId,
        toTaskId: dto.toTaskId,
        type: dto.type,
      },
    });
  }

  async removeDependency(depId: string): Promise<void> {
    const dep = await this.prisma.taskDependency.findUnique({ where: { id: depId } });
    if (!dep) {
      throw new NotFoundException('Dependency not found');
    }
    await this.prisma.taskDependency.delete({ where: { id: depId } });
  }

  async getDependencies(taskId: string) {
    return this.prisma.taskDependency.findMany({
      where: { fromTaskId: taskId },
    });
  }

  /**
   * MUN-0054 — every dependency edge touching this task, in BOTH directions,
   * with the counterpart task's status resolved.
   *
   * `getDependencies` above answers only `fromTaskId`, which is the right
   * answer to "what did someone record ON this task" and the wrong answer to
   * "is this task blocked": a `blocks` edge recorded on the blocker names the
   * blocked task in `toTaskId`, so a reader filtering on `fromTaskId` alone
   * sees an empty list for exactly the task that is blocked. That is the same
   * absent-reads-as-empty failure this task exists to close, one layer down —
   * so the readiness answer is computed here, over both columns, rather than
   * left to each caller to reassemble and get wrong in its own way.
   *
   * `status` of the counterpart is included because a dependency edge alone
   * does not say whether it still blocks: `depends_on` a task that is already
   * `done` is satisfied. A caller that receives only ids has to issue N more
   * requests, and an agent key would be refused on most of them.
   */
  async getDependencyGraph(taskId: string, agentId?: string) {
    await this.findOne(taskId); // 404 on an unknown id, not an empty graph

    const edges = await this.prisma.taskDependency.findMany({
      where: { OR: [{ fromTaskId: taskId }, { toTaskId: taskId }] },
      include: {
        fromTask: { select: { id: true, title: true, status: true } },
        toTask: { select: { id: true, title: true, status: true } },
      },
    });

    // MUN-0055 (DEC-AUP-0033 R4a). `@AgentScope('task')` checks that the key
    // owns the task in the PATH; it says nothing about the counterpart at the
    // other end of an edge, whose title was returned in clear. So a key that
    // owned one task read the titles of tasks it did not own, one edge at a
    // time — the same plaintext the field-change read above stopped handing
    // out, through a different door. The counterpart's STATUS stays: it is not
    // free text and `getReadiness` below is computed from it. A JWT is
    // unaffected — this narrows an agent key, and a user already has the whole
    // project.
    const ownedCounterparts = agentId
      ? await this.ownedAmong(
          agentId,
          edges.map((e) => (e.fromTaskId === taskId ? e.toTaskId : e.fromTaskId)),
        )
      : null;

    return edges.map((e) => {
      const outgoing = e.fromTaskId === taskId;
      const other = outgoing ? e.toTask : e.fromTask;
      const withheld = ownedCounterparts !== null && !ownedCounterparts.has(other.id);
      return {
        id: e.id,
        type: e.type,
        direction: outgoing ? ('outgoing' as const) : ('incoming' as const),
        fromTaskId: e.fromTaskId,
        toTaskId: e.toTaskId,
        otherTaskId: other.id,
        otherTaskTitle: withheld ? null : other.title,
        ...(withheld ? { otherTaskTitleWithheld: true as const } : {}),
        otherTaskStatus: other.status,
      };
    });
  }

  /** MUN-0055: which of `ids` the agent owns — assigned or creator, the same
   *  filter every other agent-key read narrows by (agentOwnTaskWhere). */
  private async ownedAmong(agentId: string, ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.prisma.task.findMany({
      where: { id: { in: [...new Set(ids)] }, ...agentOwnTaskWhere(agentId) },
      select: { id: true },
    });
    return new Set(rows.map((r) => r.id));
  }

  /**
   * MUN-0054 — the readiness question an executor actually asks, answered
   * server-side so it cannot be answered wrongly by omission client-side.
   *
   * An edge blocks this task when it is unsatisfied and points the blocking
   * way: `depends_on` recorded ON this task (outgoing), or `blocks` recorded on
   * another task and pointing AT this one (incoming). `related_to` and
   * `duplicates` are not blocking relations. An edge is satisfied once the
   * counterpart reaches a terminal status.
   */
  async getReadiness(taskId: string, agentId?: string) {
    const edges = await this.getDependencyGraph(taskId, agentId);
    const SATISFIED = new Set(['done', 'cancelled', 'archived']);

    const blockedBy = edges.filter(
      (e) =>
        ((e.type === 'depends_on' && e.direction === 'outgoing') ||
          (e.type === 'blocks' && e.direction === 'incoming')) &&
        !SATISFIED.has(e.otherTaskStatus),
    );

    return {
      taskId,
      dependencyCount: edges.length,
      blockedBy,
      ready: blockedBy.length === 0,
    };
  }

  // --- Comments (via ActivityLog) ---

  async addComment(taskId: string, actor: Actor, body: string): Promise<void> {
    const task = await this.findOne(taskId);
    const project = await this.prisma.project.findUnique({
      where: { id: task.projectId },
    });
    if (!project) {
      throw new NotFoundException('Project not found');
    }

    await this.activityService.log({
      workspaceId: project.workspaceId,
      taskId,
      actor,
      action: 'comment',
      payload: { body },
    });
  }

  async getActivity(taskId: string, page: number, limit: number) {
    return this.activityService.findForTask(taskId, page, limit);
  }
}

function isForeignKeyRestrictViolation(err: unknown): boolean {
  if (err === null || err === undefined || typeof err !== 'object') return false;
  return (err as { code?: string }).code === 'P2003';
}
