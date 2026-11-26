import { createHash, createHmac, randomBytes } from 'node:crypto';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { jest } from '@jest/globals';
import supertest from 'supertest';
import { AuthController } from '../src/auth/auth.controller.js';
import { AuthService } from '../src/auth/auth.service.js';
import type { TelegramLoginDto } from '../src/auth/dto/telegram-login.dto.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * Contract of POST /auth/telegram (TelegramLoginDto). Every payload here carries a signature that is correct for its
 * own fields, so a refusal comes from the request contract and not from a bad signature.
 */
describe('TelegramLoginDto request contract', () => {
  const botToken = 'synthetic-widget-test';
  const userId = '10000000-0000-4000-8000-000000000001';
  const findUnique = jest.fn(async () => ({ id: userId }));
  const create = jest.fn();
  let app: INestApplication;
  let auth: AuthService;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: randomBytes(32).toString('hex') }), PassportModule.register({})],
      controllers: [AuthController],
      providers: [AuthService, { provide: PrismaService, useValue: { user: { findUnique, create } } }],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    auth = module.get(AuthService);
  });

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-25T00:00:00Z'));
    jest.replaceProperty(process, 'env', { TELEGRAM_BOT_TOKEN: botToken });
    findUnique.mockClear();
    create.mockClear();
  });

  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => app?.close());

  const now = () => Math.floor(Date.now() / 1000);

  function dataCheckString(fields: Record<string, unknown>): string {
    return Object.keys(fields)
      .filter((key) => fields[key] != null)
      .sort()
      .map((key) => `${key}=${fields[key]}`)
      .join('\n');
  }

  function sign(fields: Record<string, unknown>): string {
    const key = createHash('sha256').update(botToken).digest();
    return createHmac('sha256', key).update(dataCheckString(fields)).digest('hex');
  }

  function signed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const fields = { id: 1234, first_name: 'Widget', auth_date: now(), ...overrides };
    return { ...fields, hash: sign(fields) };
  }

  const post = (body: object) => supertest(app.getHttpServer()).post('/api/v1/auth/telegram').send(body);

  async function expectRefusedByContract(body: object) {
    const verify = jest.spyOn(auth, 'verifyTelegramLogin');
    const response = await post(body).expect(400);
    expect(Array.isArray(response.body.message)).toBe(true);
    expect(verify).not.toHaveBeenCalled();
    expect(findUnique).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  }

  it.each([
    ['required fields only', {}],
    ['all optional fields', { last_name: 'Last', username: 'user_1', photo_url: 'https://t.me/i/userpic/a.jpg' }],
    ['non-Latin names, emoji, tab and inner spaces', { first_name: 'Анна 王 🙂\tдва  слова', last_name: "O'Neil = x" }],
    ['empty optional string', { last_name: '' }],
    ['a 52-bit Telegram id', { id: 2 ** 52 - 1 }],
    ['the largest safe integer id', { id: Number.MAX_SAFE_INTEGER }],
  ])('keeps accepting a signed widget payload: %s', async (_name, overrides) => {
    await post(signed(overrides)).expect(200);
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['id is not an integer', { id: 1234.5 }],
    ['id is zero', { id: 0 }],
    ['id is negative', { id: -1 }],
    ['id is above the largest safe integer', { id: 2 ** 53 }],
    ['auth_date is not an integer', { auth_date: Math.floor(Date.parse('2026-11-25T00:00:00Z') / 1000) - 0.5 }],
  ])('refuses before verification: %s', async (_name, overrides) => {
    await expectRefusedByContract(signed(overrides));
  });

  it.each(['first_name', 'last_name', 'username', 'photo_url'].flatMap((field) => [
    [field, 'LF', 'a\nb'],
    [field, 'CR', 'a\rb'],
  ]))('refuses %s containing %s', async (field, _name, value) => {
    await expectRefusedByContract(signed({ [field]: value }));
  });

  it.each([
    ['upper case', (hash: string) => hash.toUpperCase()],
    ['63 characters', (hash: string) => hash.slice(1)],
    ['65 characters', (hash: string) => `${hash}0`],
    ['trailing non-hex text', (hash: string) => `${hash}zz`],
    ['trailing newline', (hash: string) => `${hash}\n`],
  ])('refuses a hash with %s', async (_name, change) => {
    const body = signed();
    await expectRefusedByContract({ ...body, hash: change(body.hash as string) });
  });

  it('the verifier alone would accept a valid hash followed by non-hex text', () => {
    const body = signed();
    expect(auth.verifyTelegramLogin({ ...body, hash: `${body.hash as string}zz` } as unknown as TelegramLoginDto))
      .toBe(true);
  });

  /**
   * Why the line-break rule exists: the data-check string joins `key=value` lines with LF, so a line break inside a
   * value moves field boundaries. One Telegram signature then covers a second payload with another account id.
   * Assumption of this fixture: Telegram signs a name that contains a line break. That is not measured here.
   */
  it('refuses a payload that reuses one signature for another account id', async () => {
    const attacker = { auth_date: now(), first_name: 'A', id: 111, last_name: 'z\nid=999' };
    const forged = { auth_date: attacker.auth_date, first_name: 'A\nid=111\nlast_name=z', id: 999 };
    const hash = sign(attacker);

    expect(dataCheckString(forged)).toBe(dataCheckString(attacker));
    expect(auth.verifyTelegramLogin({ ...forged, hash } as TelegramLoginDto)).toBe(true);
    await expectRefusedByContract({ ...forged, hash });
  });
});
