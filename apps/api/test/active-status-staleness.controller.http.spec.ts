// MUN-0067: HTTP threshold validation for active-status staleness (no DB).
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';
import { TasksController } from '../src/tasks/tasks.controller.js';
import { TasksService } from '../src/tasks/tasks.service.js';
import { FieldChangesService } from '../src/tasks/field-state/field-changes.service.js';
import { TaskStalenessService } from '../src/execution-authority/task-staleness.service.js';
import { TaskRedactionService } from '../src/tasks/redactions/task-redaction.service.js';
import { TaskEvidenceService } from '../src/tasks/evidence/task-evidence.service.js';
import { JwtOrApiKeyGuard } from '../src/auth/guards/jwt-or-api-key.guard.js';
import { AgentTaskScopeGuard } from '../src/auth/guards/agent-task-scope.guard.js';
import { HumanTaskReadGuard } from '../src/auth/guards/human-task-read.guard.js';
import { ActorInterceptor } from '../src/common/interceptors/actor.interceptor.js';

const tasks = {
  activeStatusStalenessForProject: jest.fn<
    (...args: Parameters<TasksService['activeStatusStalenessForProject']>) =>
      ReturnType<TasksService['activeStatusStalenessForProject']>
  >(),
};
const allow = { canActivate: () => true };
const actor = {
  intercept(
    context: Parameters<ActorInterceptor['intercept']>[0],
    next: Parameters<ActorInterceptor['intercept']>[1],
  ) {
    const req = context.switchToHttp().getRequest();
    req.actor = { id: 'agent-1', type: 'agent' };
    req.agentScope = {
      kind: 'project-index',
      agentId: 'agent-1',
      projectReadGrant: {
        agentId: 'agent-1',
        projectId: 'project-1',
        decision: 'test',
        until: '2999-01-01T00:00:00Z',
      },
    };
    return next.handle();
  },
};

function getOverUnixSocket(
  socketPath: string,
  path: string,
): Promise<{ statusCode: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { socketPath, path, method: 'GET', headers: { accept: 'application/json' } },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('end', () => {
          try {
            resolve({ statusCode: response.statusCode ?? 0, body: JSON.parse(body) as unknown });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on('error', reject);
    request.end();
  });
}

describe('GET /tasks/project/:projectId/active-status-staleness threshold (HTTP)', () => {
  let app: INestApplication;
  let socketDir: string;
  let socketPath: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [TasksController],
      providers: [
        { provide: TasksService, useValue: tasks },
        { provide: FieldChangesService, useValue: {} },
        { provide: TaskStalenessService, useValue: {} },
        { provide: TaskRedactionService, useValue: {} },
        { provide: TaskEvidenceService, useValue: {} },
      ],
    })
      .overrideGuard(JwtOrApiKeyGuard)
      .useValue(allow)
      .overrideGuard(AgentTaskScopeGuard)
      .useValue(allow)
      .overrideGuard(HumanTaskReadGuard)
      .useValue(allow)
      .overrideInterceptor(ActorInterceptor)
      .useValue(actor)
      .compile();
    app = moduleRef.createNestApplication();
    app.getHttpAdapter().getInstance().set('query parser', 'extended');
    socketDir = mkdtempSync(join(tmpdir(), 'muneral-active-status-staleness-http-'));
    socketPath = join(socketDir, 'app.sock');
    await app.listen(socketPath);
  });

  beforeEach(() => {
    tasks.activeStatusStalenessForProject.mockReset().mockResolvedValue({
      projectId: 'project-1',
      generatedAt: '2026-11-08T00:00:00.000Z',
      counted: 'active',
      thresholds: { softDays: 3, hardDays: 14 },
      autoPatch: false,
      activeStatuses: ['in_progress', 'review', 'blocked'],
      byStatus: {
        in_progress: { n: 0, fresh: 0, gtSoft: 0, gtHard: 0, stale: [] },
        review: { n: 0, fresh: 0, gtSoft: 0, gtHard: 0, stale: [] },
        blocked: { n: 0, fresh: 0, gtSoft: 0, gtHard: 0, stale: [] },
      },
      auditEventId: 'audit-1',
      auditReadCount: 1,
      grant: { decision: 'test', until: '2999-01-01T00:00:00Z' },
    });
  });

  afterAll(async () => {
    if (app) await app.close();
    if (socketDir) rmSync(socketDir, { recursive: true, force: true });
  });

  it('rejects malformed, blank, non-positive, repeated, structured, overflowing, and inverted thresholds before evaluation', async () => {
    for (const query of [
      '?softDays=abc',
      '?softDays=NaN',
      '?softDays=Infinity',
      '?softDays=',
      '?softDays=%20%20',
      '?softDays=0',
      '?softDays=-1',
      '?softDays=1&softDays=2',
      '?softDays%5Bvalue%5D=1',
      '?softDays=1e302',
      '?softDays=1e309',
      '?hardDays=0',
      '?hardDays=-2',
      '?softDays=14&hardDays=3',
      '?softDays=3&hardDays=3',
    ]) {
      const response = await getOverUnixSocket(
        socketPath,
        `/tasks/project/project-1/active-status-staleness${query}`,
      );
      expect(response.statusCode).toBe(400);
    }
    expect(tasks.activeStatusStalenessForProject).not.toHaveBeenCalled();
  });

  it('uses 3d/14d defaults when omitted and converts valid fractional days', async () => {
    const defaulted = await getOverUnixSocket(
      socketPath,
      '/tasks/project/project-1/active-status-staleness',
    );
    expect(defaulted.statusCode).toBe(200);
    expect(tasks.activeStatusStalenessForProject).toHaveBeenLastCalledWith(
      'project-1',
      'agent-1',
      expect.objectContaining({ decision: 'test' }),
      { softDays: 3, hardDays: 14 },
    );

    const fractional = await getOverUnixSocket(
      socketPath,
      '/tasks/project/project-1/active-status-staleness?softDays=0.5&hardDays=1.25',
    );
    expect(fractional.statusCode).toBe(200);
    expect(tasks.activeStatusStalenessForProject).toHaveBeenLastCalledWith(
      'project-1',
      'agent-1',
      expect.objectContaining({ decision: 'test' }),
      { softDays: 0.5, hardDays: 1.25 },
    );
  });
});
