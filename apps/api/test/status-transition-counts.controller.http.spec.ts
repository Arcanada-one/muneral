// MUN-0075: HTTP window validation for status-transition counts (no DB).
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
  statusTransitionCountsForProject: jest.fn<
    (...args: Parameters<TasksService['statusTransitionCountsForProject']>) =>
      ReturnType<TasksService['statusTransitionCountsForProject']>
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

describe('GET /tasks/project/:projectId/status-transition-counts window (HTTP)', () => {
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
    socketDir = mkdtempSync(join(tmpdir(), 'muneral-status-transition-counts-http-'));
    socketPath = join(socketDir, 'app.sock');
    await app.listen(socketPath);
  });

  beforeEach(() => {
    tasks.statusTransitionCountsForProject.mockReset().mockResolvedValue({
      schemaVersion: 1,
      projectId: 'project-1',
      generatedAt: '2026-11-10T00:00:00.000Z',
      scope: {
        cohortTaskCount: 0,
        startInclusiveUtc: '2026-11-10T00:00:00.000Z',
        endExclusiveUtc: '2026-11-11T00:00:00.000Z',
        timeZone: 'UTC',
        eventAction: 'task:status_changed',
        denominatorMeaning: 'test',
      },
      inputCompleteness: { state: 'DB_COHORT_COMPLETE', evidenceId: 'audit-1' },
      transitions: {
        verdict: 'MEASURED',
        observedTotal: 0,
        dailyCounts: [{ dateUtc: '2026-11-10', count: 0 }],
        dailyCountsMeaning: 'test',
      },
      rates: { verdict: 'NOT_MEASURED', reason: 'test' },
      comparability: { verdict: 'NOT_MEASURED', reason: 'test' },
      autoPatch: false,
      auditEventId: 'audit-1',
      auditReadCount: 1,
      grant: { decision: 'test', until: '2999-01-01T00:00:00Z' },
    });
  });

  afterAll(async () => {
    if (app) await app.close();
    if (socketDir) rmSync(socketDir, { recursive: true, force: true });
  });

  it('rejects missing/malformed/inverted windows before evaluation', async () => {
    for (const query of [
      '',
      '?startInclusiveUtc=2026-11-10T00:00:00.000Z',
      '?endExclusiveUtc=2026-11-11T00:00:00.000Z',
      '?startInclusiveUtc=abc&endExclusiveUtc=2026-11-11T00:00:00.000Z',
      '?startInclusiveUtc=2026-11-11T00:00:00.000Z&endExclusiveUtc=2026-11-10T00:00:00.000Z',
      '?startInclusiveUtc=2026-11-10T00:00:00.000Z&endExclusiveUtc=2026-11-10T00:00:00.000Z',
      '?startInclusiveUtc=2026-11-10T00:00:00.000Z&startInclusiveUtc=2026-11-09T00:00:00.000Z&endExclusiveUtc=2026-11-11T00:00:00.000Z',
    ]) {
      const response = await getOverUnixSocket(
        socketPath,
        `/tasks/project/project-1/status-transition-counts${query}`,
      );
      expect(response.statusCode).toBe(400);
    }
    expect(tasks.statusTransitionCountsForProject).not.toHaveBeenCalled();
  });

  it('forwards a valid window to the service', async () => {
    const response = await getOverUnixSocket(
      socketPath,
      '/tasks/project/project-1/status-transition-counts?startInclusiveUtc=2026-11-10T00:00:00.000Z&endExclusiveUtc=2026-11-11T00:00:00.000Z',
    );
    expect(response.statusCode).toBe(200);
    expect(tasks.statusTransitionCountsForProject).toHaveBeenLastCalledWith(
      'project-1',
      'agent-1',
      expect.objectContaining({ decision: 'test' }),
      expect.objectContaining({
        startInclusiveUtc: '2026-11-10T00:00:00.000Z',
        endExclusiveUtc: '2026-11-11T00:00:00.000Z',
      }),
    );
  });
});
