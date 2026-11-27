// @vitest-environment node
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readOidcConfig } from '@/lib/auth/oidc-config';
import { RefreshRefused, type RefreshedTokens } from '@/lib/auth/auth-arcana';
import { IDLE_LIMIT_MS, TokenStore } from '@/lib/auth/token-store';
import { APP, CLIENT_ID, ISSUER, clientKeyPair } from '../test-support/fake-auth-arcana';

const { pem } = clientKeyPair();
const complete = {
  AUTH_ARCANA_ISSUER: ISSUER, AUTH_ARCANA_CLIENT_ID: CLIENT_ID, AUTH_ARCANA_CLIENT_PRIVATE_KEY: pem,
  AUTH_URL: APP, NEXTAUTH_SECRET: 'synthetic-cookie-secret',
};

describe('Auth Arcana client configuration', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is off, silently and without network, when nothing is set', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const network = vi.spyOn(globalThis, 'fetch');
    expect(await readOidcConfig({})).toBeNull();
    expect(await readOidcConfig({ NEXTAUTH_SECRET: 'only-this', AUTH_URL: APP })).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });

  it('is on when every setting is valid, including a one-line PEM and local development', async () => {
    expect(await readOidcConfig(complete)).toMatchObject({ clientId: CLIENT_ID, appOrigin: APP });
    expect(await readOidcConfig({ ...complete, AUTH_ARCANA_CLIENT_PRIVATE_KEY: pem.replace(/\n/g, '\\n') })).not.toBeNull();
    expect(await readOidcConfig({ ...complete, AUTH_URL: 'http://127.0.0.1:3501' })).not.toBeNull();
    expect((await readOidcConfig(complete))!.privateKey.extractable).toBe(false);
  });

  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    .export({ type: 'pkcs8', format: 'pem' }).toString();

  it.each([
    ['AUTH_ARCANA_ISSUER', undefined], ['AUTH_ARCANA_ISSUER', 'https://auth.example.com'],
    ['AUTH_ARCANA_ISSUER', 'http://auth.arcanada.ai'], ['AUTH_ARCANA_CLIENT_ID', undefined],
    ['AUTH_ARCANA_CLIENT_PRIVATE_KEY', undefined], ['AUTH_ARCANA_CLIENT_PRIVATE_KEY', 'not a key'],
    ['AUTH_ARCANA_CLIENT_PRIVATE_KEY', rsa], ['AUTH_URL', undefined],
    ['AUTH_URL', 'http://app.example.test'], ['AUTH_URL', `${APP}/path`], ['NEXTAUTH_SECRET', undefined],
  ])('is off when %s is %#', async (name, value) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await readOidcConfig({ ...complete, [name]: value })).toBeNull();
    const logged = warn.mock.calls.flat().join(' ');
    expect(logged).toContain(name);
    expect(logged).not.toMatch(/BEGIN|synthetic-cookie-secret|example\.com|not a key/);
  });
});

describe('token store', () => {
  const login = (expiresAt: number) => ({ accessToken: 'a1', refreshToken: 'r1', idToken: 'i1', expiresAt });
  const next: RefreshedTokens = { accessToken: 'a2', refreshToken: 'r2', expiresInSeconds: 300 };

  it('does not revive a login that was ended while its refresh was in flight', async () => {
    const store = new TokenStore();
    const id = store.create(login(Date.now() + 1_000));
    const gate = Promise.withResolvers<RefreshedTokens>();
    const pending = store.access(id, () => gate.promise);
    expect(store.end(id)?.idToken).toBe('i1');
    gate.resolve(next);
    expect(await pending).toEqual({ status: 'expired' });
    expect(await store.access(id, async () => next)).toEqual({ status: 'expired' });
    expect(store.end(id)).toBeUndefined();
  });

  it('removes a login whose grant is refused for every waiting caller', async () => {
    const store = new TokenStore();
    const id = store.create(login(Date.now() + 1_000));
    const refresh = vi.fn(async (): Promise<RefreshedTokens> => { throw new RefreshRefused(); });
    expect(await Promise.all([store.access(id, refresh), store.access(id, refresh)]))
      .toEqual([{ status: 'expired' }, { status: 'expired' }]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('ends a login without a refresh token when its access token lapses', async () => {
    const store = new TokenStore();
    const id = store.create({ accessToken: 'a1', expiresAt: Date.now() + 1_000 });
    const refresh = vi.fn(async () => next);
    expect(await store.access(id, refresh)).toEqual({ status: 'ok', accessToken: 'a1' });
    expect(await store.access(id, refresh, () => Date.now() + 5_000)).toEqual({ status: 'expired' });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('forgets idle logins and keeps a bounded number', async () => {
    const store = new TokenStore(2);
    const idle = store.create(login(Date.now() + 1e9));
    expect(await store.access(idle, async () => next, () => Date.now() + IDLE_LIMIT_MS + 1))
      .toEqual({ status: 'expired' });
    const ids = [1, 2, 3].map(() => store.create(login(Date.now() + 1e9)));
    expect(store.end(ids[0])).toBeUndefined();
    expect(store.end(ids[2])).toBeDefined();
    expect(new Set(ids).size).toBe(3);
  });
});
