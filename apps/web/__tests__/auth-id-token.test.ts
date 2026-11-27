// @vitest-environment node
// The server's own check of ID tokens. Auth.js also checks claims and alg on the code exchange, so
// these tests call this application's code directly: a flow test could not tell the two apart.
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AuthArcana from '@/lib/auth/auth-arcana';
import { readOidcConfig, type OidcConfig } from '@/lib/auth/oidc-config';
import {
  APP, CLIENT_ID, FakeAuth, ISSUER, SIGNING_JWK, SUBJECT, clientKeyPair, standInIdToken,
  type IdTokenSpoil,
} from '../test-support/fake-auth-arcana';

const keys = clientKeyPair();
let oidc: OidcConfig;
let fake: FakeAuth;
let auth: typeof AuthArcana;

beforeEach(async () => {
  oidc = (await readOidcConfig({
    AUTH_ARCANA_ISSUER: ISSUER, AUTH_ARCANA_CLIENT_ID: CLIENT_ID,
    AUTH_ARCANA_CLIENT_PRIVATE_KEY: keys.pem, AUTH_URL: APP, NEXTAUTH_SECRET: 'synthetic',
  }))!;
  fake = new FakeAuth(keys.publicKey);
  vi.stubGlobal('fetch', fake.fetch);
  // The module caches discovery and the key set for the life of the process.
  vi.resetModules();
  auth = await import('@/lib/auth/auth-arcana');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const now = () => Math.floor(Date.now() / 1000);
const claims = () => ({ iss: ISSUER, aud: CLIENT_ID, sub: SUBJECT, iat: now(), exp: now() + 300 });
const token = (spoil: IdTokenSpoil = {}) => standInIdToken(claims(), spoil);

describe('ID token verification', () => {
  it('accepts a token signed by a published key', async () => {
    await expect(auth.verifyIdToken(oidc, token())).resolves.toBeUndefined();
    expect(fake.requested).toEqual([`${ISSUER}/.well-known/openid-configuration`, `${ISSUER}/oidc/jwks`]);
  });

  it.each<[string, IdTokenSpoil, string]>([
    ['a bad signature', { foreignKey: true }, 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED'],
    ['an unknown key id', { kid: 'stand-in-signing-9' }, 'ERR_JWKS_NO_MATCHING_KEY'],
    ['alg none', { alg: 'none' }, 'ERR_JOSE_ALG_NOT_ALLOWED'],
    ['another issuer', { claims: { iss: 'https://evil.example' } }, 'ERR_JWT_CLAIM_VALIDATION_FAILED'],
    ['another audience', { claims: { aud: 'another-client' } }, 'ERR_JWT_CLAIM_VALIDATION_FAILED'],
    ['an expired lifetime', { claims: { exp: 1 } }, 'ERR_JWT_EXPIRED'],
    ['no expiry', { claims: { exp: undefined } }, 'ERR_JWT_CLAIM_VALIDATION_FAILED'],
  ])('refuses %s', async (_label, spoil, code) => {
    await expect(auth.verifyIdToken(oidc, token(spoil))).rejects.toMatchObject({ code });
  });

  it('refuses a token whose signature was cut off', async () => {
    const [header, payload] = token().split('.');
    await expect(auth.verifyIdToken(oidc, `${header}.${payload}.`)).rejects.toThrow();
  });

  it('refuses an alg outside the allow-list even when the published key names none', async () => {
    const { alg: _alg, ...unlabelled } = SIGNING_JWK;
    fake.jwks.keys = [unlabelled];
    await expect(auth.verifyIdToken(oidc, token({ alg: 'Ed25519' })))
      .rejects.toMatchObject({ code: 'ERR_JOSE_ALG_NOT_ALLOWED' });
  });

  it('refuses a published key of another type under the same key id', async () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' });
    fake.jwks.keys = [{ ...rsa, kid: SIGNING_JWK.kid, use: 'sig' }];
    await expect(auth.verifyIdToken(oidc, token())).rejects.toMatchObject({ code: 'ERR_JWKS_NO_MATCHING_KEY' });
  });

  it.each([
    ['answers 500 with a valid set', { status: 500 }],
    ['redirects', { status: 302 }],
    ['cannot be reached', { unreachable: true }],
  ])('refuses when the key set endpoint %s', async (_label, jwks) => {
    fake.jwks = jwks;
    await expect(auth.verifyIdToken(oidc, token())).rejects.toThrow();
  });

  it('asks for the key set without following redirects', async () => {
    const seen: (RequestRedirect | undefined)[] = [];
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/oidc/jwks')) seen.push(init?.redirect);
      return fake.fetch(input, init);
    });
    await auth.verifyIdToken(oidc, token());
    expect(seen).toEqual(['manual']);
  });
});

describe('the token request Auth.js makes', () => {
  const answer = (body: object, status = 200) => {
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith('/oidc/token')
        ? Promise.resolve(new Response(JSON.stringify(body), { status }))
        : fake.fetch(input, init));
  };
  const exchange = () => auth.tokenRequestFetch(oidc)(`${ISSUER}/oidc/token`, {
    method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code: 'c' }),
  });

  it('hands over a verified response with its body unread', async () => {
    const idToken = token();
    answer({ access_token: 'a', id_token: idToken });
    expect(await (await exchange()).json()).toEqual({ access_token: 'a', id_token: idToken });
  });

  it('withholds a response whose ID token does not verify', async () => {
    answer({ access_token: 'a', id_token: token({ foreignKey: true }) });
    await expect(exchange()).rejects.toMatchObject({ code: 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' });
  });

  it('withholds a successful response without an ID token', async () => {
    answer({ access_token: 'a' });
    await expect(exchange()).rejects.toThrow('The code exchange returned no ID token');
  });

  it('passes a refused exchange through for Auth.js to report', async () => {
    answer({ error: 'invalid_grant' }, 400);
    expect((await exchange()).status).toBe(400);
  });
});

describe('the ID token of a refresh response', () => {
  it('is kept when it verifies', async () => {
    fake.refreshIdToken = {};
    expect((await auth.refreshTokens(oidc, 'r1')).idToken?.split('.')).toHaveLength(3);
  });

  it.each<[string, IdTokenSpoil]>([
    ['signed by another key', { foreignKey: true }],
    ['of an unknown key id', { kid: 'stand-in-signing-9' }],
    ['with alg none', { alg: 'none' }],
    ['for another audience', { claims: { aud: 'another-client' } }],
  ])('is dropped when %s, and the rotation still stands', async (_label, spoil) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fake.refreshIdToken = spoil;
    const result = await auth.refreshTokens(oidc, 'r1');
    expect(result.idToken).toBeUndefined();
    expect(result.accessToken).toBe('fake-access-1');
    expect(result.refreshToken).toBe('fake-refresh-1');
    expect(warn.mock.calls).toEqual([['Auth Arcana: dropped an unverified ID token from a refresh response']]);
  });
});
