// @vitest-environment node
// The jwt callback: what may start a login, and which cookies are still one.
import { describe, expect, it } from 'vitest';
import { buildAuthConfig } from '@/lib/auth/config';
import { readOidcConfig } from '@/lib/auth/oidc-config';
import { tokenStore } from '@/lib/auth/token-store';
import { APP, CLIENT_ID, ISSUER, SUBJECT, clientKeyPair } from '../test-support/fake-auth-arcana';

async function jwtCallback() {
  const oidc = await readOidcConfig({
    AUTH_ARCANA_ISSUER: ISSUER, AUTH_ARCANA_CLIENT_ID: CLIENT_ID,
    AUTH_ARCANA_CLIENT_PRIVATE_KEY: clientKeyPair().pem, AUTH_URL: APP, NEXTAUTH_SECRET: 'synthetic',
  });
  const jwt = buildAuthConfig(oidc).callbacks!.jwt!;
  return (input: object) => Promise.resolve(jwt(input as Parameters<typeof jwt>[0]));
}

const account = {
  provider: 'arcanada', providerAccountId: SUBJECT, type: 'oidc',
  access_token: 'synthetic-access', id_token: 'synthetic-id',
};

describe('jwt callback', () => {
  it('starts a server-side login from a complete sign-in result', async () => {
    const jwt = await jwtCallback();
    const token = await jwt({ token: {}, user: { name: null }, account });
    expect(tokenStore().end(token!.sid as string)?.accessToken).toBe('synthetic-access');
  });

  it.each([
    ['another provider', { provider: 'credentials' }],
    ['no access token', { access_token: undefined }],
    ['no ID token', { id_token: undefined }],
  ])('refuses a sign-in result with %s', async (_label, spoil) => {
    const jwt = await jwtCallback();
    await expect(jwt({ token: {}, user: { name: null }, account: { ...account, ...spoil } }))
      .rejects.toThrow('Sign-in did not return the expected tokens');
  });

  it('keeps only its own fields of a cookie that names a server-side login', async () => {
    const jwt = await jwtCallback();
    const token = await jwt({
      token: { name: null, sub: SUBJECT, sid: 'server-id', loginSessionId: 'l', accessToken: 'carried' },
    });
    expect(token).toEqual({ name: null, sub: SUBJECT, sid: 'server-id', loginSessionId: 'l' });
  });

  it.each([
    ['has no server-side id', {}],
    ['has a non-string server-side id', { sid: 7 }],
  ])('drops a cookie that %s', async (_label, extra) => {
    const jwt = await jwtCallback();
    expect(await jwt({ token: { name: 'n', sub: SUBJECT, accessToken: 'earlier-method', ...extra } })).toBeNull();
  });
});
