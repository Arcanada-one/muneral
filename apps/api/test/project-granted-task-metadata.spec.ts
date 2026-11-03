import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Agent } from '@prisma/client';
import { AgentTaskScopeGuard } from '../src/auth/guards/agent-task-scope.guard.js';
import type { AgentScopedRequest } from '../src/auth/guards/agent-task-scope.guard.js';
import { PROJECT_READ_GRANT_LIST } from '../src/auth/project-read-grants.js';
import type { ProjectReadGrantEntry } from '../src/auth/project-read-grants.js';
import {
  PROJECT_READ_TASK_METADATA_KEY,
} from '../src/auth/project-read-task-metadata.decorator.js';
import { PROJECT_INDEX_READ_ACTION, TasksService } from '../src/tasks/tasks.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import type { ActivityService } from '../src/activity/activity.service.js';
import type { KanbanService } from '../src/ws/kanban.service.js';
import type { TaskFieldStateService } from '../src/tasks/field-state/task-field-state.service.js';
import type { TaskExecutionRecorderService } from '../src/execution-authority/task-execution-recorder.service.js';
import { TasksController } from '../src/tasks/tasks.controller.js';
import type { FieldChangesService } from '../src/tasks/field-state/field-changes.service.js';
import type { TaskStalenessService } from '../src/execution-authority/task-staleness.service.js';
import type { TaskRedactionService } from '../src/tasks/redactions/task-redaction.service.js';
import type { TaskEvidenceService } from '../src/tasks/evidence/task-evidence.service.js';
import { jest as _jestRuntime } from '@jest/globals';
const jest = _jestRuntime as unknown as typeof globalThis.jest;

const AGENT = { id: 'agent-1', workspaceId: 'workspace-1', name: 'reader' } as unknown as Agent;
const GRANT: ProjectReadGrantEntry = {
  agentId: 'agent-1',
  agentName: 'reader',
  projectId: 'project-1',
  until: '2999-01-01T00:00:00Z',
  decision: 'DEC-TEST',
  evidence: 'unit',
};

function guardContext(
  grants: readonly ProjectReadGrantEntry[],
  handler: Function = TasksController.prototype.findOne,
  method = 'GET',
) {
  const prisma = {
    task: { findFirst: jest.fn() },
  };
  const request = {
    method,
    params: { taskId: 'task-1' },
    apiKeyAgent: AGENT,
  } as unknown as AgentScopedRequest;
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => TasksController,
  } as unknown as ExecutionContext;
  const guard = new AgentTaskScopeGuard(
    new Reflector(),
    prisma as unknown as PrismaService,
    grants,
  );
  return { guard, context, request, prisma };
}

describe('project-granted GET /tasks/:taskId metadata', () => {
  it('keeps the existing AgentScope kind and adds an explicit marker only to the metadata GET', () => {
    expect(Reflect.getMetadata(PROJECT_READ_TASK_METADATA_KEY, TasksController.prototype.findOne)).toBe(true);
    expect(Reflect.getMetadata(PROJECT_READ_TASK_METADATA_KEY, TasksController.prototype.getActivity)).toBeUndefined();
    expect(Reflect.getMetadata(PROJECT_READ_TASK_METADATA_KEY, TasksController.prototype.addComment)).toBeUndefined();
    expect(Reflect.getMetadata('mun0043:agentScope', TasksController.prototype.findOne)).toBe('task');
  });

  it('allows a same-project live grant only after the ordinary ownership check misses', async () => {
    const { guard, context, request, prisma } = guardContext([GRANT]);
    prisma.task.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'task-1', projectId: 'project-1' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(prisma.task.findFirst).toHaveBeenNthCalledWith(1, {
      where: {
        id: 'task-1',
        project: { workspaceId: 'workspace-1' },
        OR: [
          { agents: { some: { agentId: 'agent-1' } } },
          { createdById: 'agent-1', actorType: 'agent' },
        ],
      },
      select: { id: true },
    });
    expect(prisma.task.findFirst).toHaveBeenNthCalledWith(2, {
      where: { id: 'task-1', project: { workspaceId: 'workspace-1' } },
      select: { id: true, projectId: true },
    });
    expect(request.projectTaskMetadataRead).toEqual({ projectId: 'project-1', grant: GRANT });
    expect(request.agentScope).toEqual({ agentId: 'agent-1', kind: 'task', workspaceId: 'workspace-1' });
  });

  it('preserves the full assigned/creator path without requiring a project grant', async () => {
    const { guard, context, request, prisma } = guardContext([]);
    prisma.task.findFirst.mockResolvedValueOnce({ id: 'task-1' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(prisma.task.findFirst).toHaveBeenCalledTimes(1);
    expect(request.agentScope).toEqual({ agentId: 'agent-1', kind: 'task', workspaceId: 'workspace-1' });
    expect(request.projectTaskMetadataRead).toBeUndefined();
  });

  it('does not let a grant authorize an unmarked history or comment route', async () => {
    for (const [handler, method] of [
      [TasksController.prototype.getActivity, 'GET'],
      [TasksController.prototype.addComment, 'POST'],
    ] as const) {
      const { guard, context, prisma, request } = guardContext([GRANT], handler, method);
      prisma.task.findFirst.mockResolvedValueOnce(null);

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.task.findFirst).toHaveBeenCalledTimes(1);
      expect(request.projectTaskMetadataRead).toBeUndefined();
    }
  });

  it('fails closed if the metadata marker is invoked by a non-GET method', async () => {
    const { guard, context, prisma } = guardContext([GRANT], TasksController.prototype.findOne, 'POST');
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.task.findFirst).not.toHaveBeenCalled();
  });

  it('denies no grant, another agent, and another project with the legacy 403', async () => {
    for (const grants of [
      [],
      [{ ...GRANT, agentId: 'agent-2' }],
      [{ ...GRANT, projectId: 'project-2' }],
    ]) {
      const { guard, context, prisma, request } = guardContext(grants);
      prisma.task.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'task-1', projectId: 'project-1' });

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
      expect(request.projectTaskMetadataRead).toBeUndefined();
    }
  });

  it('denies expired grants and tasks outside the credential workspace', async () => {
    const expired = { ...GRANT, until: '2000-01-01T00:00:00Z' };
    const expiredCase = guardContext([expired]);
    expiredCase.prisma.task.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'task-1', projectId: 'project-1' });
    const expiredError = await expiredCase.guard.canActivate(expiredCase.context).catch((error: unknown) => error);
    expect(expiredError).toBeInstanceOf(ForbiddenException);
    expect((expiredError as ForbiddenException).getResponse()).toMatchObject({
      code: 'GRANT_EXPIRED',
      projectId: 'project-1',
    });

    const outsideWorkspace = guardContext([GRANT]);
    outsideWorkspace.prisma.task.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    await expect(outsideWorkspace.guard.canActivate(outsideWorkspace.context)).rejects.toBeInstanceOf(ForbiddenException);
    expect(outsideWorkspace.request.projectTaskMetadataRead).toBeUndefined();
  });
});

describe('TasksService.findOneForProjectReadGrant', () => {
  function serviceFor() {
    const prisma = {
      task: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'task-1', projectId: 'project-1', title: 'title', description: 'description', status: 'todo',
        }),
      },
      activityLog: { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
    };
    const service = new TasksService(
      prisma as unknown as PrismaService,
      {} as ActivityService,
      {} as KanbanService,
      {} as TaskFieldStateService,
      {} as TaskExecutionRecorderService,
      [GRANT],
    );
    return { prisma, service };
  }

  it('rechecks the live grant in the service and queries only exact project/workspace metadata', async () => {
    const { prisma, service } = serviceFor();
    const result = await service.findOneForProjectReadGrant(
      'task-1', 'project-1', 'workspace-1', 'agent-1', GRANT,
    );

    expect(prisma.task.findFirst).toHaveBeenCalledWith({
      where: { id: 'task-1', projectId: 'project-1', project: { workspaceId: 'workspace-1' } },
      select: { id: true, projectId: true, title: true, description: true, status: true },
    });
    expect(Object.keys(result).sort()).toEqual([
      'auditEventId', 'description', 'id', 'projectId', 'status', 'title',
    ]);
    expect(prisma.activityLog.create).toHaveBeenCalledWith({
      data: {
        workspaceId: 'workspace-1',
        taskId: null,
        actorType: 'agent',
        actorId: 'agent-1',
        action: PROJECT_INDEX_READ_ACTION,
        payload: { projectId: 'project-1', decision: 'DEC-TEST', rowCount: 1 },
      },
      select: { id: true },
    });
    expect(result.auditEventId).toBe('audit-1');
  });

  it('refuses a grant that expired after the guard and writes no audit', async () => {
    const expired = { ...GRANT, until: '2000-01-01T00:00:00Z' };
    const { prisma, service } = serviceFor();
    const staleService = new TasksService(
      prisma as unknown as PrismaService,
      {} as ActivityService,
      {} as KanbanService,
      {} as TaskFieldStateService,
      {} as TaskExecutionRecorderService,
      [expired],
    );
    await expect(staleService.findOneForProjectReadGrant(
      'task-1', 'project-1', 'workspace-1', 'agent-1', expired,
    )).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.task.findFirst).not.toHaveBeenCalled();
    expect(prisma.activityLog.create).not.toHaveBeenCalled();
  });

  it('fails closed when the task query or audit write fails', async () => {
    const missing = serviceFor();
    missing.prisma.task.findFirst.mockResolvedValue(null);
    await expect(missing.service.findOneForProjectReadGrant(
      'task-1', 'project-1', 'workspace-1', 'agent-1', GRANT,
    )).rejects.toBeInstanceOf(ForbiddenException);
    expect(missing.prisma.activityLog.create).not.toHaveBeenCalled();

    const auditFailure = serviceFor();
    auditFailure.prisma.activityLog.create.mockRejectedValue(new Error('audit unavailable'));
    await expect(auditFailure.service.findOneForProjectReadGrant(
      'task-1', 'project-1', 'workspace-1', 'agent-1', GRANT,
    )).rejects.toThrow('audit unavailable');
  });
});

describe('TasksController.findOne compatibility', () => {
  it('routes only an internal grant context to the minimal response; assigned and human calls retain full findOne', async () => {
    const metadata = { id: 'task-1', projectId: 'project-1', title: 'title', description: 'description', status: 'todo', auditEventId: 'audit-1' };
    const fullTask = { ...metadata, auditEventId: undefined, contractDigest: null };
    const service = {
      findOne: jest.fn().mockResolvedValue(fullTask),
      findOneForProjectReadGrant: jest.fn().mockResolvedValue(metadata),
    };
    const fieldChanges = { computeTaskEtag: jest.fn().mockResolvedValue(undefined) };
    const controller = new TasksController(
      service as unknown as TasksService,
      fieldChanges as unknown as FieldChangesService,
      {} as TaskStalenessService,
      {} as TaskRedactionService,
      {} as TaskEvidenceService,
    );
    const response = { setHeader: jest.fn(), status: jest.fn() };
    const granted = {
      actor: { type: 'agent', id: 'agent-1' },
      agentScope: { agentId: 'agent-1', kind: 'task', workspaceId: 'workspace-1' },
      projectTaskMetadataRead: { projectId: 'project-1', grant: GRANT },
    } as never;

    await expect(controller.findOne('task-1', granted, undefined, response as never)).resolves.toEqual(metadata);
    expect(service.findOneForProjectReadGrant).toHaveBeenCalledWith(
      'task-1', 'project-1', 'workspace-1', 'agent-1', GRANT,
    );
    expect(service.findOne).not.toHaveBeenCalled();

    const assigned = {
      actor: { type: 'agent', id: 'agent-1' },
      agentScope: { agentId: 'agent-1', kind: 'task', workspaceId: 'workspace-1' },
    } as never;
    await expect(controller.findOne('task-1', assigned, undefined, response as never)).resolves.toEqual(fullTask);
    expect(service.findOne).toHaveBeenCalledWith('task-1', undefined);

    const human = { actor: { type: 'human', id: 'user-1' } } as never;
    await expect(controller.findOne('task-1', human, undefined, response as never)).resolves.toEqual(fullTask);
    expect(service.findOne).toHaveBeenLastCalledWith('task-1', 'user-1');
  });
});
