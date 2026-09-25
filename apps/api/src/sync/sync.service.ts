import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { TasksService } from '../tasks/tasks.service.js';
import { ActivityService } from '../activity/activity.service.js';
import { agentStatusAuthorityWhere } from '../auth/agent-task-visibility.js';
import { TASK_STATUSES, isValidTransition } from '@muneral/types';
import type { Actor, TaskStatus, TaskPriority } from '@muneral/types';

type ImportBlock = {
  title: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  dueDate?: string;
  description?: string;
};

/** One line of the import, decided before anything is written (A2-379). */
type ImportStep =
  | { kind: 'create'; block: ImportBlock }
  | {
      kind: 'update';
      taskId: string;
      status?: TaskStatus;
      fields: { priority?: string; dueDate?: string };
      /** What the task held before, for the audit row's `from` side. */
      before: { status: string; priority: string; dueDate: string | null };
    }
  | { kind: 'unchanged' };

/**
 * A2-383. The route-level audit row. The per-task rows TasksService writes
 * (`task:created`, `task:status_changed`, `task:updated`) look the same
 * whichever route caused them, so on their own they cannot answer "was the
 * import used, by whom, on which project". This row can: one per import that
 * reached the write phase, naming the project and every task it touched.
 */
export const DATARIM_IMPORT_ACTION = 'sync:datarim_imported';

type Change<T> = { from: T; to: T };

/** Payload of the `sync:datarim_imported` row. */
export type DatarimImportAudit = {
  projectId: string;
  /** `failed`: a write threw part-way; the lists hold what was applied before it. */
  outcome: 'completed' | 'failed';
  created: Array<{ taskId: string; title: string; status: string }>;
  updated: Array<{
    taskId: string;
    status?: Change<string>;
    priority?: Change<string>;
    dueDate?: Change<string | null>;
  }>;
  unchanged: number;
  error?: string;
};

/** The same bound `POST /tasks` puts on a title (CreateTaskDto). */
const MAX_TITLE_LENGTH = 500;

/**
 * SyncService — bidirectional sync with Datarim tasks.md format.
 */
@Injectable()
export class SyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tasksService: TasksService,
    private readonly activityService: ActivityService,
  ) {}

  /**
   * Export project tasks in Datarim tasks.md format.
   */
  async exportDatarim(projectId: string): Promise<string> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });
    if (!project) {
      throw new NotFoundException('Project not found');
    }

    const tasks = await this.prisma.task.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
    });

    // MUN-0043: `archived` is not active work — the card left the board — and
    // it is not `done` either, so it belongs in neither of the two existing
    // sections. It gets its own rather than being dropped: an export that
    // silently omitted archived cards would lose them on the next import.
    const activeTasks = tasks.filter(
      (t) => !['done', 'cancelled', 'archived'].includes(t.status),
    );
    const doneTasks = tasks.filter((t) => t.status === 'done');
    const archivedTasks = tasks.filter((t) => t.status === 'archived');

    const lastUpdated = new Date().toISOString().split('T')[0];
    const lines: string[] = [
      `# Tasks — ${project.name}`,
      `Last Updated: ${lastUpdated}`,
      '',
      '## Active Tasks',
    ];

    for (const task of activeTasks) {
      lines.push('', `### MUN-${task.id.slice(0, 4).toUpperCase()}: ${task.title}`);
      lines.push(`- **Status:** ${task.status}`);
      lines.push(`- **Priority:** ${task.priority}`);
      if (task.dueDate) lines.push(`- **Due:** ${task.dueDate}`);
      if (task.estimateHours) lines.push(`- **Estimate:** ${task.estimateHours}h`);
      if (task.description) lines.push(`- **Description:** ${task.description}`);
      lines.push(`- **Actor:** ${task.actorType ?? 'human'}`);
    }

    if (doneTasks.length > 0) {
      lines.push('', '## Completed Tasks');
      for (const task of doneTasks) {
        lines.push('', `### MUN-${task.id.slice(0, 4).toUpperCase()}: ${task.title}`);
        lines.push(`- **Status:** ${task.status}`);
        lines.push(`- **Priority:** ${task.priority}`);
      }
    }

    if (archivedTasks.length > 0) {
      // Deliberately NOT under "Completed Tasks": an archive card says where a
      // card went, not that its work was finished (DEC-AUP-0014 rule 3).
      lines.push('', '## Archived Tasks');
      for (const task of archivedTasks) {
        lines.push('', `### MUN-${task.id.slice(0, 4).toUpperCase()}: ${task.title}`);
        lines.push(`- **Status:** ${task.status}`);
        lines.push(`- **Priority:** ${task.priority}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Import tasks from Datarim markdown format.
   * Creates new tasks; updates existing ones matched by title.
   *
   * A2-379. Before this change the import wrote with raw Prisma calls: a
   * created task was recorded as `actorType: 'human'` with no creator whatever
   * credential called, a matched task had its status overwritten with any
   * value (no TASK_TRANSITIONS, `todo → done` in one line), and neither wrote
   * an activity row, so the audit log could not even show that it happened.
   * Now every write goes through TasksService — the same code `POST /tasks`,
   * `PATCH /tasks/:id/status` and the field update run — so authorship is the
   * key's agent, the state machine binds, and the activity log records it.
   *
   * The whole markdown is decided BEFORE the first write. A line that matches
   * a task the key may not move (not its creator, not its executor — the
   * 'task-status' rule, MUN-0050), a title that matches more than one task, a
   * move TASK_TRANSITIONS forbids or an over-long title refuses the import
   * with nothing written, rather than leaving half of it applied. A match
   * needs authority even when nothing would change: a key that could "touch"
   * a task it has no relation to is the hole this closes.
   */
  async importDatarim(
    projectId: string,
    markdown: string,
    actor: Actor | undefined,
  ): Promise<{ created: number; updated: number; unchanged: number }> {
    // The route is agent-key only (ApiKeyGuard) and its workspace wall is the
    // 'project' scope. Refuse anything else rather than guess who wrote.
    if (actor?.type !== 'agent') {
      throw new ForbiddenException('The Datarim import is available to an agent API key only.');
    }

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });
    // The 'project' scope already answers 404 for a project outside the key's
    // workspace; this repeats it where the writes are, so the import stays
    // closed even if the route ever loses its guard (the A2-379 hole was
    // exactly a route whose guard list was one entry short).
    const agent = project
      ? await this.prisma.agent.findUnique({ where: { id: actor.id }, select: { workspaceId: true } })
      : null;
    if (!project || agent?.workspaceId !== project.workspaceId) {
      throw new NotFoundException('Project not found');
    }
    if (typeof markdown !== 'string' || !markdown.trim()) {
      throw new BadRequestException('Empty markdown');
    }

    const taskBlocks = this.parseDatarimMarkdown(markdown);
    const steps: ImportStep[] = [];
    const seenTitles = new Set<string>();

    for (const [index, block] of taskBlocks.entries()) {
      const line = index + 1;
      if (block.title.length > MAX_TITLE_LENGTH) {
        throw new BadRequestException(
          `Task ${line}: title longer than ${MAX_TITLE_LENGTH} characters.`,
        );
      }
      if (seenTitles.has(block.title)) {
        throw new ConflictException({
          code: 'AMBIGUOUS_TITLE',
          message: `Task ${line}: the markdown names this title twice; nothing was imported.`,
        });
      }
      seenTitles.add(block.title);

      const matches = await this.prisma.task.findMany({
        where: { projectId, title: block.title },
        select: { id: true, status: true, priority: true, dueDate: true },
        take: 2,
      });

      if (matches.length === 0) {
        steps.push({ kind: 'create', block });
        continue;
      }
      if (matches.length > 1) {
        // Matching by title is all this format has; with two candidates any
        // choice would write to a task nobody named. Refuse instead.
        throw new ConflictException({
          code: 'AMBIGUOUS_TITLE',
          message: `Task ${line}: more than one task in this project has this title; nothing was imported.`,
        });
      }

      const existing = matches[0];
      const mayMove = await this.prisma.task.findFirst({
        where: {
          id: existing.id,
          project: { workspaceId: project.workspaceId },
          ...agentStatusAuthorityWhere(actor.id),
        },
        select: { id: true },
      });
      if (!mayMove) {
        // No task id in the answer: 'task' answers 403 for "no such task" and
        // "not yours" alike so a key cannot enumerate ids; do not undo that here.
        throw new ForbiddenException({
          code: 'IMPORT_NOT_AUTHORISED',
          message:
            `Task ${line}: agent "${actor.name}" neither created the matching task nor is its ` +
            'executor; nothing was imported (A2-379).',
        });
      }

      const status =
        block.status !== undefined && block.status !== existing.status ? block.status : undefined;
      if (status !== undefined && !isValidTransition(existing.status as TaskStatus, status)) {
        throw new BadRequestException(
          `Task ${line}: invalid status transition: ${existing.status} → ${status}; nothing was imported.`,
        );
      }
      const fields: { priority?: string; dueDate?: string } = {};
      if (block.priority !== undefined && block.priority !== existing.priority) {
        fields.priority = block.priority;
      }
      if (block.dueDate !== undefined && block.dueDate !== existing.dueDate) {
        fields.dueDate = block.dueDate;
      }

      if (status === undefined && Object.keys(fields).length === 0) {
        steps.push({ kind: 'unchanged' });
      } else {
        steps.push({
          kind: 'update',
          taskId: existing.id,
          status,
          fields,
          before: { status: existing.status, priority: existing.priority, dueDate: existing.dueDate },
        });
      }
    }

    const audit: DatarimImportAudit = {
      projectId,
      outcome: 'completed',
      created: [],
      updated: [],
      unchanged: 0,
    };

    try {
      for (const step of steps) {
        if (step.kind === 'create') {
          const task = await this.tasksService.create(actor, {
            projectId,
            title: step.block.title,
            description: step.block.description,
            status: step.block.status,
            priority: step.block.priority,
            dueDate: step.block.dueDate,
          });
          audit.created.push({ taskId: task.id, title: task.title, status: task.status });
        } else if (step.kind === 'update') {
          const entry: DatarimImportAudit['updated'][number] = { taskId: step.taskId };
          if (Object.keys(step.fields).length > 0) {
            await this.tasksService.update(step.taskId, actor, step.fields);
            if (step.fields.priority !== undefined) {
              entry.priority = { from: step.before.priority, to: step.fields.priority };
            }
            if (step.fields.dueDate !== undefined) {
              entry.dueDate = { from: step.before.dueDate, to: step.fields.dueDate };
            }
          }
          if (step.status !== undefined) {
            await this.tasksService.updateStatus(step.taskId, actor, { status: step.status });
            entry.status = { from: step.before.status, to: step.status };
          }
          audit.updated.push(entry);
        } else {
          audit.unchanged++;
        }
      }
    } catch (err) {
      // The writes are one TasksService call each, not one transaction: a
      // failure part-way leaves the earlier ones applied. Record exactly those,
      // then let the original error answer the caller.
      audit.outcome = 'failed';
      audit.error = err instanceof Error ? err.message : String(err);
      await this.writeImportAudit(project.workspaceId, actor, audit).catch(() => void 0);
      throw err;
    }

    await this.writeImportAudit(project.workspaceId, actor, audit);

    const created = audit.created.length;
    const updated = audit.updated.length;
    const unchanged = audit.unchanged;
    return { created, updated, unchanged };
  }

  private writeImportAudit(workspaceId: string, actor: Actor, audit: DatarimImportAudit) {
    return this.activityService.log({
      workspaceId,
      actor,
      action: DATARIM_IMPORT_ACTION,
      payload: audit,
    });
  }

  private parseDatarimMarkdown(markdown: string): ImportBlock[] {
    const blocks: ImportBlock[] = [];

    const lines = markdown.split('\n');
    let current: (typeof blocks)[0] | null = null;

    const VALID_STATUSES: readonly TaskStatus[] = TASK_STATUSES;
    const VALID_PRIORITIES: TaskPriority[] = [
      'critical', 'high', 'medium', 'low',
    ];

    for (const line of lines) {
      const headerMatch = line.match(/^###\s+(?:MUN-[A-Z0-9]+:\s+)?(.+)$/);
      if (headerMatch) {
        if (current) blocks.push(current);
        current = { title: headerMatch[1].trim() };
        continue;
      }

      if (!current) continue;

      const statusMatch = line.match(/^-\s+\*\*Status:\*\*\s+(.+)$/);
      if (statusMatch) {
        const s = statusMatch[1].trim() as TaskStatus;
        if (VALID_STATUSES.includes(s)) current.status = s;
        continue;
      }

      const priorityMatch = line.match(/^-\s+\*\*Priority:\*\*\s+(.+)$/);
      if (priorityMatch) {
        const p = priorityMatch[1].trim() as TaskPriority;
        if (VALID_PRIORITIES.includes(p)) current.priority = p;
        continue;
      }

      const dueMatch = line.match(/^-\s+\*\*Due:\*\*\s+(.+)$/);
      if (dueMatch) {
        current.dueDate = dueMatch[1].trim();
        continue;
      }

      const descMatch = line.match(/^-\s+\*\*Description:\*\*\s+(.+)$/);
      if (descMatch) {
        current.description = descMatch[1].trim();
      }
    }

    if (current) blocks.push(current);
    return blocks;
  }
}
