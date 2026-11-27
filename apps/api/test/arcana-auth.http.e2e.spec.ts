// HTTP: the real AuthModule, both JWT guards and the real ApiKeyGuard in a real Nest app.
// Only the database and the Auth Arcana key endpoint are substitutes.
import { Controller, Get, INestApplication, Req, UseGuards } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import { exportSPKI } from 'jose';
import request from 'supertest';
import { jest as _jestRuntime } from '@jest/globals';
import { AuthModule } from '../src/auth/auth.module.js';
import { AuthService } from '../src/auth/auth.service.js';
import { ARCANA_KEY_SOURCE } from '../src/auth/arcana/arcana-key-source.js';
import { LegacyAuthCounter } from '../src/auth/arcana/legacy-auth.counter.js';
import { JwtAuthGuard } from '../src/auth/guards/jwt-auth.guard.js';
import { JwtOrApiKeyGuard } from '../src/auth/guards/jwt-or-api-key.guard.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
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

type ProbeRequest = { user?: { id: string }; apiKeyAgent?: { id: string } };

@Controller('probe')
class ProbeController {
  @Get('jwt')
  @UseGuards(JwtAuthGuard)
  jwt(@Req() req: ProbeRequest) {
    return { user: req.user?.id ?? null };
  }

  @Get('either')
  @UseGuards(JwtOrApiKeyGuard)
  either(@Req() req: ProbeRequest) {
    return { user: req.user?.id ?? null, agent: req.apiKeyAgent?.id ?? null };
  }
}

const API_KEY = `mun_sk_${'0123456789abcdef'.repeat(2)}`;
const localUser = { id: LOCAL_USER_ID, name: 'Linked User' };
const ROUTES = ['/probe/jwt', '/probe/either'];

function fakePrisma(keyHash: string) {
  return {
    user: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
        where.id === LOCAL_USER_ID ? localUser : null,
      ),
      create: jest.fn(),
    },
    authIdentityLink: {
      findUnique: jest.fn(async ({ where }: { where: { authUserId: string } }) =>
        where.authUserId === ARCANA_USER_ID ? { authUserId: ARCANA_USER_ID, user: localUser } : null,
      ),
      create: jest.fn(),
      upsert: jest.fn(),
    },
    apiKey: {
      findUnique: jest.fn(async () => ({
        id: 'key-1',
        keyHash,
        revokedAt: null,
        expiresAt: null,
        agent: { id: 'agent-1', workspaceId: 'ws-1' },
      })),
      findMany: jest.fn(async () => []),
      update: jest.fn(async () => ({})),
    },
  };
}

describe('HTTP authentication with the Auth Arcana path', () => {
  let issuer: Issuer;
  let keyHash: string;
  let app: INestApplication | undefined;
  let jwks: JwksServer | undefined;
  let prisma: ReturnType<typeof fakePrisma>;

  beforeAll(async () => {
    issuer = await createIssuer();
    keyHash = await bcrypt.hash(API_KEY, 4);
  });

  afterEach(async () => {
    await app?.close();
    await jwks?.close();
    app = undefined;
    jwks = undefined;
  });

  /** `enabled: false` leaves the real provider in place, with no AUTH_ARCANA_* variable. */
  async function start({ enabled = true } = {}) {
    prisma = fakePrisma(keyHash);
    jwks = await startJwksServer(issuer);
    const builder = Test.createTestingModule({
      imports: [PrismaModule, AuthModule],
      controllers: [ProbeController],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma);
    if (enabled) builder.overrideProvider(ARCANA_KEY_SOURCE).useValue(jwks.keySource());
    const moduleRef = await builder.compile();
    app = moduleRef.createNestApplication();
    await app.init();
    return {
      get: (path: string, token?: string) => {
        const call = request(app!.getHttpServer()).get(path);
        return token ? call.set('Authorization', `Bearer ${token}`) : call;
      },
      legacyAccess: () => moduleRef.get(AuthService).signAccess(LOCAL_USER_ID),
      moduleRef,
    };
  }

  const noWrites = () => {
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.authIdentityLink.create).not.toHaveBeenCalled();
    expect(prisma.authIdentityLink.upsert).not.toHaveBeenCalled();
  };

  it.each(ROUTES)('%s accepts a linked Auth user as the LOCAL user', async (route) => {
    const http = await start();

    const response = await http.get(route, await mintAccessToken(issuer));

    expect(response.status).toBe(200);
    expect(response.body.user).toBe(LOCAL_USER_ID);
    expect(prisma.authIdentityLink.findUnique).toHaveBeenCalledWith({
      where: { authUserId: ARCANA_USER_ID },
      include: { user: true },
    });
    noWrites();
  });

  it.each(ROUTES)('%s refuses an unlinked Auth user with a typed 403 and creates nothing', async (route) => {
    const http = await start();
    const token = await mintAccessToken(issuer, {
      claims: { sub: '0192f0c1-0000-7000-8000-000000000000' },
    });

    const response = await http.get(route, token);

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('auth_identity_unlinked');
    noWrites();
  });

  it.each(ROUTES)('%s refuses unacceptable Auth tokens with 401 and never tries the legacy verifier', async (route) => {
    const http = await start();
    const tokens = [
      await mintAccessToken(issuer, { claims: { iss: 'https://example.invalid' } }),
      await mintAccessToken(issuer, { claims: { aud: 'urn:other' } }),
      await mintAccessToken(issuer, { header: { typ: 'JWT' } }),
      await mintAccessToken(issuer, { claims: { client_id: 'other' } }),
      await mintAccessToken(issuer, { header: { kid: 'unknown' } }),
      await mintAccessToken(issuer, {
        header: { typ: 'JWT' },
        claims: { aud: 'arc_muneral_web', client_id: undefined, scope: undefined },
      }),
    ];

    for (const token of tokens) {
      expect((await http.get(route, token)).status).toBe(401);
    }
    // The legacy path is the only one that looks a user up by id.
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.authIdentityLink.findUnique).not.toHaveBeenCalled();
  });

  it.each(ROUTES)('%s refuses HS256 signed with the public key and never asks for keys', async (route) => {
    const http = await start();
    const publicPem = await exportSPKI(issuer.keys.publicKey as Parameters<typeof exportSPKI>[0]);
    const token = await mintAccessToken(issuer, {
      header: { alg: 'HS256' },
      claims: { sub: LOCAL_USER_ID, type: 'access' },
      key: new TextEncoder().encode(publicPem),
    });

    expect((await http.get(route, token)).status).toBe(401);
    expect(jwks!.hits()).toBe(0);
    expect(prisma.authIdentityLink.findUnique).not.toHaveBeenCalled();
  });

  it.each(ROUTES)('%s keeps accepting the legacy access token, without asking for keys', async (route) => {
    const http = await start();

    const response = await http.get(route, http.legacyAccess());

    expect(response.status).toBe(200);
    expect(response.body.user).toBe(LOCAL_USER_ID);
    expect(jwks!.hits()).toBe(0);
  });

  it.each(['HS384', 'HS512'] as const)('refuses %s with the legacy secret: the algorithm is pinned', async (algorithm) => {
    const http = await start();
    const token = new JwtService({ secret: process.env.JWT_SECRET }).sign(
      { sub: LOCAL_USER_ID, type: 'access' },
      { algorithm, expiresIn: '5m' },
    );

    expect((await http.get('/probe/jwt', token)).status).toBe(401);
  });

  it('during a JWKS outage only Auth tokens fail, with a retryable 503', async () => {
    const http = await start();
    jwks!.fail(true);

    for (const route of ROUTES) {
      expect((await http.get(route, await mintAccessToken(issuer))).status).toBe(503);
      expect((await http.get(route, http.legacyAccess())).status).toBe(200);
    }
    const agent = await http.get('/probe/either', API_KEY);
    expect(agent.status).toBe(200);
    expect(agent.body.agent).toBe('agent-1');
    expect(prisma.authIdentityLink.findUnique).not.toHaveBeenCalled();
  });

  it('leaves mun_sk_ keys as they were: agent on the either guard, refused on the JWT guard', async () => {
    const http = await start();

    const either = await http.get('/probe/either', API_KEY);
    const jwtOnly = await http.get('/probe/jwt', API_KEY);

    expect(either.status).toBe(200);
    expect(either.body).toEqual({ user: null, agent: 'agent-1' });
    expect(jwtOnly.status).toBe(401);
    expect(jwks!.hits()).toBe(0);
  });

  it.each(ROUTES)('%s refuses a request with no token', async (route) => {
    const http = await start();

    expect((await http.get(route)).status).toBe(401);
  });

  describe('switch off (no new variable)', () => {
    const saved = process.env.AUTH_ARCANA_ENABLED;
    beforeAll(() => {
      delete process.env.AUTH_ARCANA_ENABLED;
    });
    afterAll(() => {
      if (saved !== undefined) process.env.AUTH_ARCANA_ENABLED = saved;
    });

    it('refuses an otherwise valid Auth token with 401, with no key fetch and no link lookup', async () => {
      const fetchSpy = jest.spyOn(globalThis, 'fetch');
      const http = await start({ enabled: false });

      for (const route of ROUTES) {
        expect((await http.get(route, await mintAccessToken(issuer))).status).toBe(401);
      }
      expect((await http.get('/probe/jwt', http.legacyAccess())).status).toBe(200);
      expect((await http.get('/probe/either', API_KEY)).status).toBe(200);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(prisma.authIdentityLink.findUnique).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });
  });

  describe('legacy-use counter', () => {
    it('counts accepted legacy requests only, and logs numbers without token or user data', async () => {
      const http = await start();
      const counter = http.moduleRef.get(LegacyAuthCounter);
      const lines: string[] = [];
      const log = jest
        .spyOn((counter as unknown as { logger: { log(line: string): void } }).logger, 'log')
        .mockImplementation((line: string) => {
          lines.push(line);
        });
      const legacy = http.legacyAccess();

      await http.get('/probe/jwt', legacy);
      await http.get('/probe/either', legacy);
      await http.get('/probe/either', API_KEY);
      await http.get('/probe/jwt', await mintAccessToken(issuer));
      await http.get('/probe/jwt', 'not-a-token');
      const unknownUser = new JwtService({ secret: process.env.JWT_SECRET }).sign(
        { sub: ARCANA_USER_ID, type: 'access' },
        { expiresIn: '5m' },
      );
      await http.get('/probe/jwt', unknownUser);
      counter.report();
      counter.report();

      expect(lines).toEqual([
        'legacy_auth_verified first_since_start surface=http',
        'legacy_auth_verified window_http=2 window_ws=0 since_start_http=2 since_start_ws=0',
        'legacy_auth_verified window_http=0 window_ws=0 since_start_http=2 since_start_ws=0',
      ]);
      expect(lines.join('\n')).not.toContain(LOCAL_USER_ID);
      expect(lines.join('\n')).not.toContain(legacy);
      log.mockRestore();
    });
  });
});
