import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/** Current authorization for a Kanban subscription or individual delivery. */
@Injectable()
export class KanbanAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async mayReadProject(projectId: string, userId: unknown): Promise<boolean> {
    if (typeof userId !== 'string' || !userId) return false;
    try {
      return !!await this.prisma.project.findFirst({
        where: { id: projectId, workspace: { members: { some: { userId } } } },
        select: { id: true },
      });
    } catch {
      // An unavailable authorization store cannot authorize a disclosure.
      return false;
    }
  }
}
