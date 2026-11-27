// @vitest-environment node
// The server's own check of ID tokens. Auth.js also checks claims and alg on the code exchange, so
// these tests call this application's code directly: a flow test could not tell the two apart.
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AuthArcana from '@/lib/auth/auth-arcana';
import { KEY_SET_COOLDOWN_MS, KEY_SET_MAX_AGE_MS } from '@/lib/auth/id-token';
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
const rejected = (reason: string) => `ID token rejected: ${reason}`;
const keySetReads = () => fake.requested.filter((url) => url.endsWith('/oidc/jwks')).length;
/** Moves the clock without faking timers. Tokens made afterwards are dated at the new time. */
const later = (milliseconds: number) => {
  const at = Date.now() + milliseconds;
  vi.spyOn(Date, 'now').mockReturnValue(at);
};

describe('ID token verification', () => {
  it('accepts a token signed by a published key', async () => {
    await expect(auth.verifyIdToken(oidc, token())).resolves.toBeUndefined();
    expect(fake.requested).toEqual([`${ISSUER}/.well-known/openid-configuration`, `${ISSUER}/oidc/jwks`]);
  });

  it.each<[string, Record<string, unknown>]>([
    ['an audience list that names this client', { aud: ['another', CLIENT_ID] }],
    ['an expiry just inside the clock tolerance', { exp: Math.floor(Date.now() / 1000) - 5 }],
    ['a start just inside the clock tolerance', { nbf: Math.floor(Date.now() / 1000) + 5 }],
  ])('accepts %s', async (_label, spoil) => {
    await expect(auth.verifyIdToken(oidc, token({ claims: spoil }))).resolves.toBeUndefined();
  });

  it.each<[string, IdTokenSpoil, string]>([
    ['a bad signature', { foreignKey: true }, 'signature'],
    ['an unknown key id', { kid: 'stand-in-signing-9' }, 'unknown key'],
    ['no key id', { header: { kid: undefined } }, 'unknown key'],
    ['alg none', { alg: 'none' }, 'algorithm'],
    // Signed correctly with the published key: only the allow-list refuses it.
    ['another alg name', { alg: 'Ed25519' }, 'algorithm'],
    ['a critical header', { header: { crit: ['exp'] } }, 'critical header'],
    ['another issuer', { claims: { iss: 'https://evil.example' } }, 'issuer'],
    ['another audience', { claims: { aud: 'another-client' } }, 'audience'],
    ['an audience list without this client', { claims: { aud: ['another-client'] } }, 'audience'],
    ['an expired lifetime', { claims: { exp: 1 } }, 'expiry'],
    ['no expiry', { claims: { exp: undefined } }, 'expiry'],
    ['an expiry that is not a number', { claims: { exp: '9999999999' } }, 'expiry'],
    ['a start in the future', { claims: { nbf: 9_999_999_999 } }, 'not yet valid'],
    ['a start that is not a number', { claims: { nbf: '1' } }, 'not yet valid'],
  ])('refuses %s', async (_label, spoil, reason) => {
    await expect(auth.verifyIdToken(oidc, token(spoil))).rejects.toThrow(rejected(reason));
  });

  it('refuses a signature cut off, changed claims, and text that is not a token', async () => {
    const [header, payload, signature] = token().split('.');
    await expect(auth.verifyIdToken(oidc, `${header}.${payload}.`)).rejects.toThrow(rejected('signature'));
    const changed = Buffer.from(JSON.stringify({ ...claims(), sub: 'someone-else' })).toString('base64url');
    await expect(auth.verifyIdToken(oidc, `${header}.${changed}.${signature}`)).rejects.toThrow(rejected('signature'));
    await expect(auth.verifyIdToken(oidc, `${header}.${payload}.${signature}.extra`)).rejects.toThrow(rejected('malformed'));
    await expect(auth.verifyIdToken(oidc, 'not-a-token')).rejects.toThrow(rejected('malformed'));
    await expect(auth.verifyIdToken(oidc, `bm90LWpzb24.${payload}.${signature}`)).rejects.toThrow(rejected('malformed'));
  });

  const { x: _x, ...withoutX } = SIGNING_JWK as typeof SIGNING_JWK & { x: string };
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' });

  // Each entry is the signing key itself with one property wrong, under the right key id.
  it.each<[string, object[]]>([
    ['is under another key id', [{ ...SIGNING_JWK, kid: 'stand-in-signing-2' }]],
    ['is of another key type', [{ ...rsa, kid: SIGNING_JWK.kid, use: 'sig' }]],
    ['is labelled with another key type', [{ ...SIGNING_JWK, kty: 'EC' }]],
    ['names another curve', [{ ...SIGNING_JWK, crv: 'X25519' }]],
    ['names another alg', [{ ...SIGNING_JWK, alg: 'Ed25519' }]],
    ['is for encryption', [{ ...SIGNING_JWK, use: 'enc' }]],
    ['may not verify', [{ ...SIGNING_JWK, key_ops: ['sign'] }]],
    ['has no public value', [withoutX]],
    ['appears twice', [SIGNING_JWK, SIGNING_JWK]],
  ])('refuses when the published key %s', async (_label, published) => {
    fake.jwks.keys = published;
    await expect(auth.verifyIdToken(oidc, token())).rejects.toThrow(rejected('unknown key'));
  });

  it('accepts a published key without alg, use or key_ops, beside an unusable entry', async () => {
    const { alg: _alg, use: _use, ...bare } = SIGNING_JWK;
    fake.jwks.keys = [null as unknown as object, bare];
    await expect(auth.verifyIdToken(oidc, token())).resolves.toBeUndefined();
  });

  it.each([
    ['answers 500 with a valid set', { status: 500 }],
    ['redirects', { status: 302 }],
    ['answers without a key list', { keys: 'none' as unknown as object[] }],
  ])('refuses when the key set endpoint %s', async (_label, jwks) => {
    fake.jwks = jwks;
    await expect(auth.verifyIdToken(oidc, token())).rejects.toThrow(rejected('key set unavailable'));
  });

  it('refuses when the key set cannot be reached, and reads it again next time', async () => {
    fake.jwks = { unreachable: true };
    await expect(auth.verifyIdToken(oidc, token())).rejects.toThrow('fetch failed');
    fake.jwks = {};
    await expect(auth.verifyIdToken(oidc, token())).resolves.toBeUndefined();
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

  it('keeps the key set, and reads it once more for a rotated key after the cooldown', async () => {
    const rotated = { kid: 'stand-in-signing-2' };
    await auth.verifyIdToken(oidc, token());
    await auth.verifyIdToken(oidc, token());
    expect(keySetReads()).toBe(1);
    fake.jwks.keys = [{ ...SIGNING_JWK, ...rotated }];
    // Inside the cooldown an unknown key id causes no further request.
    await expect(auth.verifyIdToken(oidc, token(rotated))).rejects.toThrow(rejected('unknown key'));
    expect(keySetReads()).toBe(1);
    later(KEY_SET_COOLDOWN_MS + 1);
    await expect(auth.verifyIdToken(oidc, token(rotated))).resolves.toBeUndefined();
    expect(keySetReads()).toBe(2);
  });

  it('stops accepting a withdrawn key once the key set is too old', async () => {
    await auth.verifyIdToken(oidc, token());
    fake.jwks.keys = [];
    await expect(auth.verifyIdToken(oidc, token())).resolves.toBeUndefined();
    later(KEY_SET_MAX_AGE_MS + 1);
    await expect(auth.verifyIdToken(oidc, token())).rejects.toThrow(rejected('unknown key'));
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
    await expect(exchange()).rejects.toThrow('ID token rejected: signature');
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
