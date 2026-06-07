import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TaskStatus, TaskPriority } from '@muneral/types';

/**
 * SyncService — bidirectional sync with Datarim tasks.md format.
 */
@Injectable()
export class SyncService {
  constructor(private readonly prisma: PrismaService) {}

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

    const activeTasks = tasks.filter(
      (t) => !['done', 'cancelled'].includes(t.status),
    );
    const doneTasks = tasks.filter((t) => t.status === 'done');

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

    return lines.join('\n');
  }

  /**
   * Import tasks from Datarim markdown format.
   * Creates new tasks; updates existing ones matched by title.
   */
  async importDatarim(projectId: string, markdown: string): Promise<{ created: number; updated: number }> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });
    if (!project) {
      throw new NotFoundException('Project not found');
    }
    if (!markdown?.trim()) {
      throw new BadRequestException('Empty markdown');
    }

    const taskBlocks = this.parseDatarimMarkdown(markdown);
    let created = 0;
    let updated = 0;

    for (const block of taskBlocks) {
      const existing = await this.prisma.task.findFirst({
        where: { projectId, title: block.title },
      });

      if (existing) {
        await this.prisma.task.update({
          where: { id: existing.id },
          data: {
            status: block.status ?? existing.status,
            priority: block.priority ?? existing.priority,
            dueDate: block.dueDate ?? existing.dueDate,
          },
        });
        updated++;
      } else {
        await this.prisma.task.create({
          data: {
            projectId,
            title: block.title,
            description: block.description ?? null,
            status: block.status ?? 'todo',
            priority: block.priority ?? 'medium',
            dueDate: block.dueDate ?? null,
            actorType: 'human',
          },
        });
        created++;
      }
    }

    return { created, updated };
  }

  private parseDatarimMarkdown(markdown: string): Array<{
    title: string;
    status?: TaskStatus;
    priority?: TaskPriority;
    dueDate?: string;
    description?: string;
  }> {
    const blocks: Array<{
      title: string;
      status?: TaskStatus;
      priority?: TaskPriority;
      dueDate?: string;
      description?: string;
    }> = [];

    const lines = markdown.split('\n');
    let current: (typeof blocks)[0] | null = null;

    const VALID_STATUSES: TaskStatus[] = [
      'todo', 'in_progress', 'review', 'blocked', 'done', 'cancelled',
    ];
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
