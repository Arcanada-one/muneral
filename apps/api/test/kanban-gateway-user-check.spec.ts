/**
 * The kanban gateway accepts a connection only when the token's user exists. The gateway,
 * JwtService and AuthService.validateJwtPayload are the real ones; only the database query
 * and the membership lookup are stubbed.
 */
import { jest as _jestRuntime } from '@jest/globals';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { AuthService } from '../src/auth/auth.service.js';
import { getJwtSecret } from '../src/auth/jwt-secret.js';
import { ProjectMembershipService } from '../src/plan-graph/project-membership.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { KanbanGateway } from '../src/ws/kanban.gateway.js';

const jest = _jestRuntime as unknown as typeof globalThis.jest;

describe('KanbanGateway connection: the token user must exist', () => {
  const findUnique = jest.fn();
  const lookup = jest.fn();
  let gateway: KanbanGateway;
  let token: string;

  beforeEach(async () => {
    findUnique.mockReset();
    lookup.mockReset();
    const moduleRef = await Test.createTestingModule({
      providers: [
        KanbanGateway,
        AuthService,
        { provide: JwtService, useValue: new JwtService({ secret: getJwtSecret() }) },
        { provide: PrismaService, useValue: { user: { findUnique } } },
        { provide: ProjectMembershipService, useValue: { lookup } },
      ],
    }).compile();
    gateway = moduleRef.get(KanbanGateway);
    token = moduleRef.get(JwtService).sign({ sub: 'user-1', type: 'access' }, { expiresIn: '5m' });
  });

  function fakeSocket() {
    return {
      handshake: { auth: { token } },
      data: {} as Record<string, unknown>,
      disconnect: jest.fn(),
      join: jest.fn(),
    };
  }

  it('refuses a token whose user was deleted', async () => {
    findUnique.mockResolvedValue(null as never);
    const socket = fakeSocket();

    await gateway.handleConnection(socket as never);

    expect(findUnique).toHaveBeenCalledWith({ where: { id: 'user-1' } });
    expect(socket.disconnect).toHaveBeenCalledWith(true);
    expect(socket.data['userId']).toBeUndefined();
  });

  it('accepts a token whose user exists', async () => {
    findUnique.mockResolvedValue({ id: 'user-1' } as never);
    const socket = fakeSocket();

    await gateway.handleConnection(socket as never);

    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(socket.data['userId']).toBe('user-1');
  });

  it('refuses the connection when the user lookup fails', async () => {
    findUnique.mockRejectedValue(new Error('database unavailable') as never);
    const socket = fakeSocket();

    await gateway.handleConnection(socket as never);

    expect(socket.disconnect).toHaveBeenCalledWith(true);
    expect(socket.data['userId']).toBeUndefined();
  });

  it('makes join:project wait for the user lookup still in flight', async () => {
    let resolveUser!: (user: unknown) => void;
    findUnique.mockReturnValue(new Promise((resolve) => { resolveUser = resolve; }) as never);
    lookup.mockResolvedValue({ userId: 'user-1', projectId: 'p1', isMember: true } as never);
    const socket = fakeSocket();

    const connected = gateway.handleConnection(socket as never);
    const joined = gateway.handleJoinProject({ projectId: 'p1' }, socket as never);
    resolveUser({ id: 'user-1' });
    await connected;

    await expect(joined).resolves.toEqual({ ok: true, reason: 'current_project_membership' });
    expect(socket.join).toHaveBeenCalledWith('project:p1');
  });
});
