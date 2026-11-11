// MUN-0072: HTTP wiring for GET /agents/keys/self (no DB).
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
  ownApiKeyProjection: jest.fn<(...args: unknown[]) => unknown>(),
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

describe('GET /agents/keys/self (HTTP)', () => {
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
    socketDir = mkdtempSync(join(tmpdir(), 'muneral-agents-keys-self-http-'));
    const socketPath = join(socketDir, 'app.sock');
    await app.listen(socketPath);
    (globalThis as { __munAgentsKeysSelfSock?: string }).__munAgentsKeysSelfSock = socketPath;
  });

  afterAll(async () => {
    if (app) await app.close();
    if (socketDir) rmSync(socketDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    agents.ownApiKeyProjection.mockReset();
  });

  it('returns the self key projection from AgentsService.ownApiKeyProjection', async () => {
    const socketPath = (globalThis as { __munAgentsKeysSelfSock?: string }).__munAgentsKeysSelfSock;
    expect(socketPath).toBeTruthy();
    const projection = {
      id: 'key-1',
      agentId: 'agent-1',
      label: 'runtime-1',
      lastUsedAt: '2026-11-10T13:00:00.000Z',
      expiresAt: null,
      revokedAt: null,
      createdAt: '2026-11-01T00:00:00.000Z',
    };
    agents.ownApiKeyProjection.mockImplementation(async () => projection);
    const answer = await getOverUnixSocket(socketPath!, '/agents/keys/self');
    expect(answer.statusCode).toBe(200);
    expect(answer.body).toEqual(projection);
    expect(agents.ownApiKeyProjection).toHaveBeenCalledWith('key-1', 'agent-1');
  });
});
