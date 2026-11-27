// WebSocket: the gateway wired by the REAL WsModule and AuthModule, so that a missing provider
// (the new gateway dependencies are optional) cannot pass here. Database and key endpoint are
// substitutes; the socket is a stand-in object.
import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { jest as _jestRuntime } from '@jest/globals';
import { ArcanaAuthService } from '../src/auth/arcana/arcana-auth.service.js';
import { ARCANA_KEY_SOURCE } from '../src/auth/arcana/arcana-key-source.js';
import { LegacyAuthCounter } from '../src/auth/arcana/legacy-auth.counter.js';
import { JwtStrategy } from '../src/auth/strategies/jwt.strategy.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { KanbanGateway } from '../src/ws/kanban.gateway.js';
import { WsModule } from '../src/ws/ws.module.js';
import { ProjectMembershipService } from '../src/plan-graph/project-membership.service.js';
import {
  ARCANA_USER_ID,
  LOCAL_USER_ID,
  createIssuer,
  mintAccessToken,
  startJwksServer,
  type Issuer,
  type JwksServer,
} from './support/arcana-tokens.js';

const jest = _jestRuntime as unknown as typeof globalThis.jest;
const now = () => Math.floor(Date.now() / 1000);
const localUser = { id: LOCAL_USER_ID };

function fakeSocket(token: string) {
  return {
    handshake: { auth: { token } },
    data: {} as Record<string, unknown>,
    disconnected: false,
    disconnect: jest.fn(),
    join: jest.fn(),
  };
}

describe('KanbanGateway with the composite verifier', () => {
  let issuer: Issuer;
  let jwks: JwksServer;
  let moduleRef: TestingModule;
  let gateway: KanbanGateway;
  let jwtService: JwtService;
  const userLookup = jest.fn();
  const linkLookup = jest.fn();
  const membership = jest.fn();

  beforeAll(async () => {
    issuer = await createIssuer();
  });

  beforeEach(async () => {
    userLookup.mockReset().mockResolvedValue(localUser as never);
    linkLookup.mockReset().mockImplementation((async ({ where }: { where: { authUserId: string } }) =>
      where.authUserId === ARCANA_USER_ID ? { authUserId: ARCANA_USER_ID, user: localUser } : null) as never);
    membership
      .mockReset()
      .mockResolvedValue({ userId: LOCAL_USER_ID, projectId: 'p1', isMember: true } as never);
    jwks = await startJwksServer(issuer);
    moduleRef = await Test.createTestingModule({ imports: [PrismaModule, WsModule] })
      .overrideProvider(PrismaService)
      .useValue({ user: { findUnique: userLookup }, authIdentityLink: { findUnique: linkLookup } })
      .overrideProvider(ProjectMembershipService)
      .useValue({ lookup: membership })
      .overrideProvider(ARCANA_KEY_SOURCE)
      .useValue(jwks.keySource())
      .compile();
    gateway = moduleRef.get(KanbanGateway, { strict: false });
    // The JwtService the gateway actually holds (WsModule's registration).
    jwtService = (gateway as unknown as { jwtService: JwtService }).jwtService;
  });

  afterEach(async () => {
    jest.useRealTimers();
    await moduleRef.close();
    await jwks.close();
  });

  /** Fake only the timers and the clock; sockets and WebCrypto keep running. */
  const fakeClock = () =>
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });

  const legacyToken = (expiresIn: string | number) =>
    jwtService.sign({ sub: LOCAL_USER_ID, type: 'access' }, { expiresIn: expiresIn as number });

  it('is wired with the same verifier and counter as HTTP', () => {
    const gatewayParts = gateway as unknown as Record<string, unknown>;
    const strategy = moduleRef.get(JwtStrategy, { strict: false }) as unknown as Record<string, unknown>;

    expect(gatewayParts['arcanaAuth']).toBeInstanceOf(ArcanaAuthService);
    expect(gatewayParts['legacyAuthCounter']).toBeInstanceOf(LegacyAuthCounter);
    expect(strategy['arcanaAuth']).toBe(gatewayParts['arcanaAuth']);
    expect(strategy['legacyAuthCounter']).toBe(gatewayParts['legacyAuthCounter']);
  });

  it('accepts a linked Auth user under the LOCAL user id and lets it join its project', async () => {
    const socket = fakeSocket(await mintAccessToken(issuer));

    await gateway.handleConnection(socket as never);

    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(socket.data['userId']).toBe(LOCAL_USER_ID);
    await expect(gateway.handleJoinProject({ projectId: 'p1' }, socket as never)).resolves.toEqual({
      ok: true,
      reason: 'current_project_membership',
    });
    expect(membership).toHaveBeenCalledWith(LOCAL_USER_ID, 'p1');
    gateway.handleDisconnect(socket as never);
  });

  it.each([
    ['unlinked', { claims: { sub: '0192f0c1-0000-7000-8000-000000000000' } }],
    ['wrong audience', { claims: { aud: 'urn:other' } }],
    ['wrong token type', { header: { typ: 'JWT' } }],
    ['expired', { claims: { exp: now() - 60 } }],
  ])('disconnects an %s Auth token without trying the legacy verifier', async (_name, overrides) => {
    const verifySpy = jest.spyOn(jwtService, 'verify');
    const socket = fakeSocket(await mintAccessToken(issuer, overrides));

    await gateway.handleConnection(socket as never);

    expect(socket.disconnect).toHaveBeenCalledWith(true);
    expect(socket.data['userId']).toBeUndefined();
    expect(verifySpy).not.toHaveBeenCalled();
    expect(userLookup).not.toHaveBeenCalled();
  });

  it('disconnects an Auth token during a JWKS outage while a legacy token still connects', async () => {
    jwks.fail(true);
    const arcana = fakeSocket(await mintAccessToken(issuer));
    const legacy = fakeSocket(legacyToken('5m'));

    await gateway.handleConnection(arcana as never);
    await gateway.handleConnection(legacy as never);

    expect(arcana.disconnect).toHaveBeenCalledWith(true);
    expect(legacy.disconnect).not.toHaveBeenCalled();
    expect(legacy.data['userId']).toBe(LOCAL_USER_ID);
    gateway.handleDisconnect(legacy as never);
  });

  it.each(['HS384', 'HS512'] as const)('disconnects %s signed with the legacy secret', async (algorithm) => {
    const socket = fakeSocket(
      jwtService.sign({ sub: LOCAL_USER_ID, type: 'access' }, { algorithm, expiresIn: '5m' }),
    );

    await gateway.handleConnection(socket as never);

    expect(socket.disconnect).toHaveBeenCalledWith(true);
    expect(socket.data['userId']).toBeUndefined();
  });

  it.each([
    ['Auth', async () => mintAccessToken(issuer, { claims: { exp: now() + 300 } })],
    ['legacy', async () => legacyToken(300)],
  ])('disconnects a connected %s socket when its token expires, not before', async (_name, mint) => {
    fakeClock();
    const socket = fakeSocket(await mint());
    await gateway.handleConnection(socket as never);

    jest.advanceTimersByTime(298_000);
    expect(socket.disconnect).not.toHaveBeenCalled();
    jest.advanceTimersByTime(3_000);

    expect(socket.disconnect).toHaveBeenCalledWith(true);
    expect(socket.data['userId']).toBeUndefined();
    await expect(gateway.handleJoinProject({ projectId: 'p1' }, socket as never)).resolves.toMatchObject({
      ok: false,
    });
  });

  it('does not fire early for an expiry beyond the longest timer Node accepts', async () => {
    fakeClock();
    const timeouts = jest.spyOn(globalThis, 'setTimeout');
    const socket = fakeSocket(legacyToken('60d'));
    await gateway.handleConnection(socket as never);
    const day = 24 * 60 * 60 * 1000;
    // Checked before the clock moves: a longer delay fires at once and re-arms without end.
    for (const [, delay] of timeouts.mock.calls) {
      expect(delay ?? 0).toBeLessThanOrEqual(2 ** 31 - 1);
    }
    timeouts.mockRestore();

    jest.advanceTimersByTime(59 * day);
    expect(socket.disconnect).not.toHaveBeenCalled();
    jest.advanceTimersByTime(2 * day);

    expect(socket.disconnect).toHaveBeenCalledTimes(1);
  });

  it('clears the expiry timer when the client leaves first', async () => {
    fakeClock();
    const socket = fakeSocket(legacyToken(300));
    await gateway.handleConnection(socket as never);
    expect(jest.getTimerCount()).toBe(1);

    gateway.handleDisconnect(socket as never);

    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(600_000);
    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  it('sets no timer for a client that left while being authenticated', async () => {
    fakeClock();
    const socket = fakeSocket(legacyToken(300));
    socket.disconnected = true;

    await gateway.handleConnection(socket as never);

    expect(jest.getTimerCount()).toBe(0);
  });

  it('counts accepted legacy connections only', async () => {
    const record = jest.spyOn(moduleRef.get(LegacyAuthCounter, { strict: false }), 'record');
    const sockets = [
      fakeSocket(legacyToken('5m')),
      fakeSocket(await mintAccessToken(issuer)),
      fakeSocket('not-a-token'),
    ];

    for (const socket of sockets) await gateway.handleConnection(socket as never);

    expect(record.mock.calls).toEqual([['ws']]);
    sockets.forEach((socket) => gateway.handleDisconnect(socket as never));
  });
});
