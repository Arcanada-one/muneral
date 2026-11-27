// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getToken: vi.fn(), signOut: vi.fn(), loadOidcConfig: vi.fn() }));
vi.mock('next-auth/jwt', () => ({ getToken: mocks.getToken }));
vi.mock('@/lib/auth/nextauth', () => ({ signOut: mocks.signOut }));
vi.mock('@/lib/auth/oidc-config', async (original) => ({
  ...(await original<typeof import('@/lib/auth/oidc-config')>()), loadOidcConfig: mocks.loadOidcConfig,
}));
vi.mock('@/lib/preferences/server', () => ({ readPreferences: async () => ({ locale: 'zh', theme: 'dark' }) }));

import { POST } from '@/app/api/logout/route';
import { readOidcConfig } from '@/lib/auth/oidc-config';
import { tokenStore } from '@/lib/auth/token-store';
import { APP, CLIENT_ID, FakeAuth, ISSUER, clientKeyPair } from '../test-support/fake-auth-arcana';

const keys = clientKeyPair();
let sid: string;
const request = (origin: string | null, host = 'app.example.test') =>
  new Request(`${APP}/api/logout`, { method: 'POST', headers: { host, ...(origin ? { origin } : {}) } });

beforeEach(async () => {
  mocks.loadOidcConfig.mockResolvedValue(await readOidcConfig({
    AUTH_ARCANA_ISSUER: ISSUER, AUTH_ARCANA_CLIENT_ID: CLIENT_ID, AUTH_ARCANA_CLIENT_PRIVATE_KEY: keys.pem,
    AUTH_URL: APP, NEXTAUTH_SECRET: 'synthetic',
  }));
  vi.stubGlobal('fetch', new FakeAuth(keys.publicKey).fetch);
  sid = tokenStore().create({ accessToken: 'a', refreshToken: 'r', idToken: 'synthetic-id-token', expiresAt: Date.now() + 1e6 });
  mocks.getToken.mockReset().mockResolvedValue({ sid });
  mocks.signOut.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

const stillHeld = () => tokenStore().end(sid) !== undefined;

describe('logout', () => {
  it.each([['another site', 'https://evil.example'], ['a missing Origin', null], ['a look-alike', `${APP}.evil.example`]])(
    'refuses %s and keeps the login', async (_label, origin) => {
      const response = await POST(request(origin));
      expect(response.status).toBe(403);
      expect(mocks.signOut).not.toHaveBeenCalled();
      expect(stillHeld()).toBe(true);
    });

  it('drops the local login and sends the browser to Auth end_session', async () => {
    const response = await POST(request(APP));
    expect(response.status).toBe(303);
    expect(mocks.signOut).toHaveBeenCalledWith({ redirect: false });
    const target = new URL(response.headers.get('location')!);
    expect(target.origin + target.pathname).toBe(`${ISSUER}/oidc/logout`);
    expect(Object.fromEntries(target.searchParams)).toEqual({
      client_id: CLIENT_ID, post_logout_redirect_uri: `${APP}/login`, ui_locales: 'zh',
      id_token_hint: 'synthetic-id-token',
    });
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(stillHeld()).toBe(false);
  });

  it('still ends the local login when Auth cannot be reached', async () => {
    const oidc = await mocks.loadOidcConfig();
    mocks.loadOidcConfig.mockResolvedValue({ ...oidc, issuer: 'https://unreachable.example' });
    vi.stubGlobal('fetch', async () => { throw new TypeError('fetch failed'); });
    const response = await POST(request(APP));
    expect(response.headers.get('location')).toBe(`${APP}/login`);
    expect(mocks.signOut).toHaveBeenCalled();
    expect(stillHeld()).toBe(false);
  });

  it('works with sign-in off: same host only, back to the local login page', async () => {
    mocks.loadOidcConfig.mockResolvedValue(null);
    expect((await POST(request('https://evil.example'))).status).toBe(403);
    const response = await POST(request(APP));
    expect(response.headers.get('location')).toBe(`${APP}/login`);
  });
});
