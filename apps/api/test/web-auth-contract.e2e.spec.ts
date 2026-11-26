import { randomBytes, createHash, createHmac } from 'node:crypto';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { jest } from '@jest/globals';
import supertest from 'supertest';
import { AuthController } from '../src/auth/auth.controller.js';
import { AuthService } from '../src/auth/auth.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

describe('Web authentication HTTP contract', () => {
  const secret = randomBytes(32).toString('hex');
  const botToken = 'synthetic-widget-test';
  const userId = '10000000-0000-4000-8000-000000000001';
  const findUnique = jest.fn(async () => ({ id: userId }));
  const create = jest.fn();
  let app: INestApplication;
  let jwt: JwtService;
  let auth: AuthService;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [JwtModule.register({ secret }), PassportModule.register({})],
      controllers: [AuthController],
      providers: [AuthService, {
        provide: PrismaService,
        useValue: { user: { findUnique, create } },
      }],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }));
    await app.init();
    jwt = module.get(JwtService);
    auth = module.get(AuthService);
  });

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-25T00:00:00Z'));
    jest.replaceProperty(process, 'env', {
      GITHUB_CLIENT_ID: 'synthetic-app-id',
      GITHUB_CLIENT_SECRET: 'synthetic-app-value',
      TELEGRAM_BOT_TOKEN: botToken,
    });
    findUnique.mockClear();
    create.mockClear();
  });

  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => app?.close());

  function post(route: string) {
    return supertest(app.getHttpServer()).post(`/api/v1/auth/${route}`);
  }

  function assertPair(tokens: { access_token: string; refresh_token: string }) {
    expect(jwt.verify(tokens.access_token)).toMatchObject({ type: 'access', sub: userId });
    expect(jwt.verify(tokens.refresh_token)).toMatchObject({ type: 'refresh', sub: userId });
  }

  function widgetData(age = 0) {
    const auth_date = Math.floor(Date.now() / 1000) - age;
    const secretKey = createHash('sha256').update(botToken).digest();
    const hash = createHmac('sha256', secretKey)
      .update(`auth_date=${auth_date}\nfirst_name=Widget\nid=1234`)
      .digest('hex');
    return { id: 1234, first_name: 'Widget', auth_date, hash };
  }

  it('exchanges an app-verified GitHub credential for Muneral tokens', async () => {
    const verify = jest.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
      app: { client_id: 'synthetic-app-id' },
      user: { id: 1234, login: 'widget' },
    }));
    const response = await post('github').send({ access_token: 'synthetic_oauth_value' }).expect(200);
    expect(verify).toHaveBeenCalledWith('https://api.github.com/applications/synthetic-app-id/token',
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        body: JSON.stringify({ access_token: 'synthetic_oauth_value' }),
      }));
    expect(findUnique).toHaveBeenCalledWith({ where: { githubId: 1234n } });
    assertPair(response.body);
  });

  it('refuses an asserted GitHub identity before contacting the provider', async () => {
    const verify = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected lookup'));
    await post('github').send({ githubId: 1234, email: 'fixture@example.test' }).expect(400);
    expect(verify).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it.each([[404, 401], [200, 401]])(
    'refuses GitHub responses without a verified identity (provider %i, API %i)',
    async (providerStatus, apiStatus) => {
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
        app: { client_id: 'another-app' },
        user: { id: 1234, login: 'widget' },
      }, { status: providerStatus }));
      await post('github').send({ access_token: 'synthetic_oauth_value' }).expect(apiStatus);
      expect(findUnique).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    },
  );

  it.each([299, 300, -30])('accepts a signed Telegram Widget payload with age %i seconds', async (age) => {
    const response = await post('telegram').send(widgetData(age)).expect(200);
    expect(findUnique).toHaveBeenCalledWith({ where: { telegramId: 1234n } });
    assertPair(response.body);
  });

  it.each([301, -31])('refuses a signed Telegram Widget payload with age %i seconds', async (age) => {
    await post('telegram').send(widgetData(age)).expect(400);
    expect(findUnique).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses a changed identity from the Telegram widget', async () => {
    await post('telegram').send({ ...widgetData(), id: 4321 }).expect(400);
    expect(findUnique).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('uses a valid refresh JWT to issue only an access JWT for the existing user', async () => {
    const response = await post('refresh').send({ refresh_token: auth.signRefresh(userId) }).expect(200);
    expect(Object.keys(response.body)).toEqual(['access_token']);
    expect(jwt.verify(response.body.access_token)).toMatchObject({ type: 'access', sub: userId });
  });

  it('refuses forged, expired, and access JWTs at the refresh route', async () => {
    const payload = { sub: userId, type: 'refresh' };
    const forged = new JwtService({ secret: randomBytes(32).toString('hex') })
      .sign(payload, { expiresIn: '1h' });
    const expired = jwt.sign(payload, { expiresIn: -1 });
    for (const token of [forged, expired, auth.signAccess(userId)]) {
      await post('refresh').send({ refresh_token: token }).expect(401);
    }
    expect(findUnique).not.toHaveBeenCalled();
  });
});
