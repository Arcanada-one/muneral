// @vitest-environment node
// What this server accepts from Auth Arcana's discovery document and refresh endpoint. Each fixture
// is valid except for the one thing named by its test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AuthArcana from '@/lib/auth/auth-arcana';
import type * as Logout from '@/lib/auth/logout';
import { readOidcConfig, type OidcConfig } from '@/lib/auth/oidc-config';
import { APP, CLIENT_ID, FakeAuth, ISSUER, clientKeyPair } from '../test-support/fake-auth-arcana';

const keys = clientKeyPair();
const DISCOVERY = `${ISSUER}/.well-known/openid-configuration`;
let oidc: OidcConfig;
let fake: FakeAuth;
let auth: typeof AuthArcana;
let logout: typeof Logout;

beforeEach(async () => {
  oidc = (await readOidcConfig({
    AUTH_ARCANA_ISSUER: ISSUER, AUTH_ARCANA_CLIENT_ID: CLIENT_ID,
    AUTH_ARCANA_CLIENT_PRIVATE_KEY: keys.pem, AUTH_URL: APP, NEXTAUTH_SECRET: 'synthetic',
  }))!;
  fake = new FakeAuth(keys.publicKey);
  vi.stubGlobal('fetch', fake.fetch);
  // A successful discovery is cached for the life of the process.
  vi.resetModules();
  auth = await import('@/lib/auth/auth-arcana');
  logout = await import('@/lib/auth/logout');
});
afterEach(() => vi.unstubAllGlobals());

describe('discovery', () => {
  it('accepts the issuer\'s own document', async () => {
    expect(await auth.discover(oidc)).toEqual({
      tokenEndpoint: `${ISSUER}/oidc/token`,
      jwksUri: `${ISSUER}/oidc/jwks`,
      endSessionEndpoint: `${ISSUER}/oidc/logout`,
    });
  });

  it.each([404, 500])('refuses a %i answer even with a valid body', async (status) => {
    fake.discovery.status = status;
    await expect(auth.refreshTokens(oidc, 'r1')).rejects.toThrow('Discovery failed');
    expect(fake.requested).toEqual([DISCOVERY]);
  });

  it.each([
    ['names another issuer', { issuer: 'https://evil.example' }],
    ['puts the token endpoint on another host', { token_endpoint: 'https://evil.example/oidc/token' }],
    ['puts the token endpoint on a look-alike host', { token_endpoint: `${ISSUER}.evil.example/oidc/token` }],
    ['puts the key set on another host', { jwks_uri: 'https://evil.example/oidc/jwks' }],
    ['puts the key set on a look-alike host', { jwks_uri: `${ISSUER}.evil.example/oidc/jwks` }],
    ['names no key set', { jwks_uri: undefined }],
  ])('refuses a document that %s, and sends nothing further', async (_label, patch) => {
    fake.discovery.patch = patch;
    await expect(auth.refreshTokens(oidc, 'r1')).rejects.toThrow('Unexpected discovery document');
    // Neither the refresh token nor the client assertion left the server.
    expect(fake.requested).toEqual([DISCOVERY]);
    expect(fake.calls).toEqual([]);
  });

  it.each([
    ['another host', 'https://evil.example/oidc/logout'],
    ['a look-alike host', `${ISSUER}.evil.example/oidc/logout`],
  ])('ignores an end_session endpoint on %s: the ID token goes nowhere', async (_label, endpoint) => {
    fake.discovery.patch = { end_session_endpoint: endpoint };
    expect((await auth.discover(oidc)).endSessionEndpoint).toBeUndefined();
    expect(await logout.afterLogoutUrl(oidc, APP, 'synthetic-id-token', 'en')).toBe(`${APP}/login`);
  });
});

describe('refresh response', () => {
  const answer = (body: object) => {
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith('/oidc/token')
        ? Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
        : fake.fetch(input, init));
  };

  it('is accepted with a non-empty string access token', async () => {
    answer({ access_token: 'a2' });
    expect(await auth.refreshTokens(oidc, 'r1')).toMatchObject({ accessToken: 'a2' });
  });

  it.each([
    ['a number as the access token', { access_token: 123 }],
    ['an empty access token', { access_token: '' }],
    ['no access token', {}],
  ])('is refused with %s', async (_label, body) => {
    answer(body);
    await expect(auth.refreshTokens(oidc, 'r1')).rejects.toThrow('Refresh failed with status 200');
  });
});
