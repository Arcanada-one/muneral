// MUN-0071: HTTP wiring for GET /agents/me (no DB).
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';
import { AgentsController } from '../src/agents/agents.controller.js';
import { AgentsService } from '../src/agents/agents.service.js';
import { ApiKeyGuard } from '../src/auth/guards/api-key.guard.js';
import { JwtAuthGuard } from '../src/auth/guards/jwt-auth.guard.js';
import { JwtOrApiKeyGuard } from '../src/auth/guards/jwt-or-api-key.guard.js';
import { AgentTaskScopeGuard } from '../src/auth/guards/agent-task-scope.guard.js';
import { ActorInterceptor } from '../src/common/interceptors/actor.interceptor.js';

const agents = {
  selfIdentity: jest.fn<(...args: unknown[]) => unknown>(),
  getAgentTasks: jest.fn(),
  register: jest.fn(),
  findByWorkspace: jest.fn(),
  assignToTask: jest.fn(),
  removeFromTask: jest.fn(),
  createApiKey: jest.fn(),
  rotateApiKey: jest.fn(),
  revokeOwnApiKey: jest.fn(),
  revokeApiKey: jest.fn(),
};

const allow = {
  canActivate(context: { switchToHttp: () => { getRequest: () => Record<string, unknown> } }) {
    const req = context.switchToHttp().getRequest();
    req.apiKeyAgent = {
      id: 'agent-1',
      workspaceId: 'ws-1',
      name: 'runtime-1',
      model: 'auto',
      provider: 'cursor',
      createdAt: new Date('2026-11-10T13:00:00.000Z'),
    };
    req.apiKeyId = 'key-1';
    return true;
  },
};

const actor = {
  intercept(
    context: Parameters<ActorInterceptor['intercept']>[0],
    next: Parameters<ActorInterceptor['intercept']>[1],
  ) {
    const req = context.switchToHttp().getRequest();
    req.actor = { id: 'agent-1', type: 'agent' };
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

describe('GET /agents/me (HTTP)', () => {
  let app: INestApplication | undefined;
  let socketDir: string | undefined;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AgentsController],
      providers: [{ provide: AgentsService, useValue: agents }],
    })
      .overrideGuard(ApiKeyGuard)
      .useValue(allow)
      .overrideGuard(JwtAuthGuard)
      .useValue(allow)
      .overrideGuard(JwtOrApiKeyGuard)
      .useValue(allow)
      .overrideGuard(AgentTaskScopeGuard)
      .useValue(allow)
      .overrideInterceptor(ActorInterceptor)
      .useValue(actor)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    socketDir = mkdtempSync(join(tmpdir(), 'muneral-agents-me-http-'));
    const socketPath = join(socketDir, 'app.sock');
    await app.listen(socketPath);
    (globalThis as { __munAgentsMeSock?: string }).__munAgentsMeSock = socketPath;
  });

  afterAll(async () => {
    if (app) await app.close();
    if (socketDir) rmSync(socketDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    agents.selfIdentity.mockReset();
  });

  it('returns the self projection from AgentsService.selfIdentity', async () => {
    const socketPath = (globalThis as { __munAgentsMeSock?: string }).__munAgentsMeSock;
    expect(socketPath).toBeTruthy();
    const projection = {
      id: 'agent-1',
      workspaceId: 'ws-1',
      name: 'runtime-1',
      model: 'auto',
      provider: 'cursor',
      createdAt: '2026-11-10T13:00:00.000Z',
      apiKeyId: 'key-1',
    };
    agents.selfIdentity.mockReturnValue(projection);
    const answer = await getOverUnixSocket(socketPath!, '/agents/me');
    expect(answer.statusCode).toBe(200);
    expect(answer.body).toEqual(projection);
    expect(agents.selfIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'agent-1', workspaceId: 'ws-1' }),
      'key-1',
    );
  });
});
