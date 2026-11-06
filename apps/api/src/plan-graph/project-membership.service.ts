// KCLIVE-10 AC4: persistence-backed project membership lookup.
// Kept out of the WebSocket gateway so transport units do not import Prisma
// directly (fitness FR-01).

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ProjectMembershipRow } from './project-membership.js';

@Injectable()
export class ProjectMembershipService {
  constructor(private readonly prisma: PrismaService) {}

  async lookup(
    userId: string | undefined,
    projectId: string | undefined,
  ): Promise<ProjectMembershipRow | null> {
    if (!userId || !projectId) return null;
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        workspace: {
          select: {
            members: {
              where: { userId },
              select: { userId: true },
              take: 1,
            },
          },
        },
      },
    });
    if (!project) {
      return { userId, projectId, isMember: false };
    }
    return {
      userId,
      projectId,
      isMember: project.workspace.members.length > 0,
    };
  }
}
