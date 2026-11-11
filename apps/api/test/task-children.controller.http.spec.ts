// MUN-0070: HTTP wiring for GET /tasks/:taskId/children (no DB).
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
  listChildren: jest.fn<(...args: Parameters<TasksService['listChildren']>) => ReturnType<TasksService['listChildren']>>(),
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

describe('GET /tasks/:taskId/children (HTTP)', () => {
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
      .overrideGuard(JwtOrApiKeyGuard).useValue(allow)
      .overrideGuard(AgentTaskScopeGuard).useValue(allow)
      .overrideGuard(HumanTaskReadGuard).useValue(allow)
      .overrideInterceptor(ActorInterceptor).useValue(actor)
      .compile();
    app = moduleRef.createNestApplication();
    socketDir = mkdtempSync(join(tmpdir(), 'muneral-children-http-'));
    socketPath = join(socketDir, 'app.sock');
    await app.listen(socketPath);
  });

  beforeEach(() => {
    tasks.listChildren.mockReset().mockResolvedValue({
      parentId: 'parent-1',
      counted: 'every direct child task of the parent (parentId match), all statuses including cancelled and archived',
      total: 0,
      projection: 'full',
      tasks: [],
    });
  });

  afterAll(async () => {
    if (app) await app.close();
    if (socketDir) rmSync(socketDir, { recursive: true, force: true });
  });

  it('routes to listChildren with the human actor id', async () => {
    const response = await getOverUnixSocket(socketPath, '/tasks/parent-1/children');
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ parentId: 'parent-1', projection: 'full', total: 0 });
    expect(tasks.listChildren).toHaveBeenCalledWith('parent-1', 'human-1');
  });
});
