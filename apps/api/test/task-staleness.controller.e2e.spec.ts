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
import type { TaskStalenessEntry } from '../src/execution-authority/task-staleness.service.js';
import { TaskRedactionService } from '../src/tasks/redactions/task-redaction.service.js';
import { TaskEvidenceService } from '../src/tasks/evidence/task-evidence.service.js';
import { JwtOrApiKeyGuard } from '../src/auth/guards/jwt-or-api-key.guard.js';
import { AgentTaskScopeGuard } from '../src/auth/guards/agent-task-scope.guard.js';
import { HumanTaskReadGuard } from '../src/auth/guards/human-task-read.guard.js';
import { ActorInterceptor } from '../src/common/interceptors/actor.interceptor.js';

const staleness = {
  reportForProject: jest.fn<(...args: Parameters<TaskStalenessService['reportForProject']>) => Promise<TaskStalenessEntry[]>>(),
};
const allow = { canActivate: () => true };
const actor = {
  intercept(context: Parameters<ActorInterceptor['intercept']>[0], next: Parameters<ActorInterceptor['intercept']>[1]) {
    context.switchToHttp().getRequest().actor = { id: 'human-1', type: 'human' };
    return next.handle();
  },
};

function getOverUnixSocket(socketPath: string, path: string): Promise<{ statusCode: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ socketPath, path, method: 'GET', headers: { accept: 'application/json' } }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { body += chunk; });
      response.on('end', () => {
        try {
          resolve({ statusCode: response.statusCode ?? 0, body: JSON.parse(body) as unknown });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', reject);
    request.end();
  });
}

describe('GET /tasks/project/:projectId/staleness threshold (HTTP)', () => {
  let app: INestApplication;
  let socketDir: string;
  let socketPath: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [TasksController],
      providers: [
        { provide: TasksService, useValue: {} },
        { provide: FieldChangesService, useValue: {} },
        { provide: TaskStalenessService, useValue: staleness },
        { provide: TaskRedactionService, useValue: {} },
        { provide: TaskEvidenceService, useValue: {} },
      ],
    })
      .overrideGuard(JwtOrApiKeyGuard).useValue(allow)
      .overrideGuard(AgentTaskScopeGuard).useValue(allow)
      .overrideGuard(HumanTaskReadGuard).useValue(allow)
      .overrideInterceptor(ActorInterceptor).useValue(actor)
      .compile();
    app = moduleRef.createNestApplication();
    app.getHttpAdapter().getInstance().set('query parser', 'extended');
    socketDir = mkdtempSync(join(tmpdir(), 'muneral-staleness-http-'));
    socketPath = join(socketDir, 'app.sock');
    await app.listen(socketPath);
  });

  beforeEach(() => staleness.reportForProject.mockReset().mockResolvedValue([
    { taskId: 'task-1', priority: 'high', verdict: 'not_measured', ageMs: null, reason: 'no attempt' },
  ]));

  afterAll(async () => {
    if (app) await app.close();
    if (socketDir) rmSync(socketDir, { recursive: true, force: true });
  });

  it('rejects malformed, blank, non-positive, repeated, structured, and overflowing values before evaluation', async () => {
    for (const query of [
      '?thresholdHours=abc', '?thresholdHours=NaN', '?thresholdHours=Infinity',
      '?thresholdHours=', '?thresholdHours=%20%20', '?thresholdHours=0',
      '?thresholdHours=-1', '?thresholdHours=1&thresholdHours=2',
      '?thresholdHours%5Bvalue%5D=1', '?thresholdHours=1e302', '?thresholdHours=1e309',
    ]) {
      const response = await getOverUnixSocket(socketPath, `/tasks/project/project-1/staleness${query}`);
      expect(response.statusCode).toBe(400);
    }
    expect(staleness.reportForProject).not.toHaveBeenCalled();
  });

  it('uses the 24-hour service default when omitted and converts valid fractional hours', async () => {
    const defaulted = await getOverUnixSocket(socketPath, '/tasks/project/project-1/staleness');
    expect(defaulted.statusCode).toBe(200);
    expect((defaulted.body as Array<{ verdict: string }>)[0].verdict).toBe('not_measured');
    expect(staleness.reportForProject).toHaveBeenLastCalledWith(
      'project-1', undefined, undefined, undefined, 'human-1',
    );

    const fractional = await getOverUnixSocket(socketPath, '/tasks/project/project-1/staleness?thresholdHours=0.5');
    expect(fractional.statusCode).toBe(200);
    expect((fractional.body as Array<{ verdict: string }>)[0].verdict).toBe('not_measured');
    expect(staleness.reportForProject).toHaveBeenLastCalledWith(
      'project-1', 30 * 60_000, undefined, undefined, 'human-1',
    );
  });
});
