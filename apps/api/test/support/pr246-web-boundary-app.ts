import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Module, ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuthModule } from '../../dist/auth/auth.module.js';
import { AuthService } from '../../dist/auth/auth.service.js';
import { PrismaModule } from '../../dist/prisma/prisma.module.js';
import { PrismaService } from '../../dist/prisma/prisma.service.js';
import { ProjectsModule } from '../../dist/projects/projects.module.js';
import { TasksModule } from '../../dist/tasks/tasks.module.js';
import { WorkspacesModule } from '../../dist/workspaces/workspaces.module.js';
import { KanbanService } from '../../dist/ws/kanban.service.js';
import { createDisposablePostgres } from './disposable-postgres.js';

class Pr246WebBoundaryModule {}
Module({ imports: [PrismaModule, AuthModule, WorkspacesModule, ProjectsModule, TasksModule] })(Pr246WebBoundaryModule);

/** Real HTTP fixture for web read adapters, backed by an owned disposable DB. */
export async function createPr246WebBoundaryApp() {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const db = createDisposablePostgres('pr246-web-boundary');
  let app: INestApplication | undefined;
  try {
    await db.start();
    process.env.DATABASE_URL = db.url();
    const moduleRef = await Test.createTestingModule({ imports: [Pr246WebBoundaryModule] })
      .overrideProvider(KanbanService)
      .useValue({ notify: () => undefined })
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0, '127.0.0.1');

    const prisma = moduleRef.get(PrismaService);
    const auth = moduleRef.get(AuthService);
    const suffix = randomUUID().slice(0, 8);
    const owner = await prisma.user.create({ data: { name: `pr246-owner-${suffix}` } });
    const workspace = await prisma.workspace.create({
      data: { slug: `pr246-${suffix}`, name: `PR246 ${suffix}`, ownerId: owner.id },
    });
    await prisma.workspaceMember.create({
      data: { workspaceId: workspace.id, userId: owner.id, role: 'owner' },
    });
    const project = await prisma.project.create({
      data: { workspaceId: workspace.id, slug: `project-${suffix}`, name: `Project ${suffix}` },
    });
    const task = await prisma.task.create({
      data: { projectId: project.id, title: `Task ${suffix}`, status: 'todo', priority: 'medium', actorType: 'human', createdById: owner.id },
    });
    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string') throw new Error('PR246 test server has no TCP address');
    return {
      baseUrl: `http://127.0.0.1:${address.port}`,
      ownerToken: auth.signAccess(owner.id),
      ownerId: owner.id,
      workspaceId: workspace.id,
      workspaceSlug: workspace.slug,
      projectId: project.id,
      projectSlug: project.slug,
      taskId: task.id,
      async close() {
        try { await app?.close(); } finally {
          try { await db.stop(); } finally {
            if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
            else process.env.DATABASE_URL = previousDatabaseUrl;
          }
        }
      },
    };
  } catch (error) {
    try { await app?.close(); } finally {
      try { await db.stop(); } finally {
        if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = previousDatabaseUrl;
      }
    }
    throw error;
  }
}
