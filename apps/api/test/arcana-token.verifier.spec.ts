// The Auth Arcana access-token verifier on its own: one accepted shape, and the refusals.
import { exportSPKI, generateKeyPair, SignJWT, UnsecuredJWT } from 'jose';
import { jest as _jestRuntime } from '@jest/globals';
import {
  ARCANA_JWKS_URL,
  ArcanaKeysUnavailable,
  ArcanaTokenRejected,
  unverifiedAlgorithm,
  verifyArcanaAccessToken,
} from '../src/auth/arcana/arcana-token.verifier.js';
import { arcanaKeySourceFromEnv } from '../src/auth/arcana/arcana-key-source.js';
import {
  ARCANA_USER_ID,
  createIssuer,
  mintAccessToken,
  startJwksServer,
  type Issuer,
  type JwksServer,
  type TokenOverrides,
} from './support/arcana-tokens.js';

const jest = _jestRuntime as unknown as typeof globalThis.jest;
const now = () => Math.floor(Date.now() / 1000);

describe('verifyArcanaAccessToken', () => {
  let issuer: Issuer;
  let jwks: JwksServer;

  beforeAll(async () => {
    issuer = await createIssuer();
  });
  beforeEach(async () => {
    jwks = await startJwksServer(issuer);
  });
  afterEach(async () => {
    await jwks.close();
  });

  const verify = (token: string) => verifyArcanaAccessToken(token, jwks.keySource());

  it('accepts the expected access token and returns the Auth user id and expiry', async () => {
    const exp = now() + 120;
    const token = await mintAccessToken(issuer, { claims: { exp } });

    await expect(verify(token)).resolves.toEqual({ sub: ARCANA_USER_ID, expiresAt: exp });
  });

  it('accepts a one-element audience list and the long form of the token type', async () => {
    const token = await mintAccessToken(issuer, {
      claims: { aud: ['urn:arcanada:muneral:api'] },
      header: { typ: 'application/at+jwt' },
    });

    await expect(verify(token)).resolves.toMatchObject({ sub: ARCANA_USER_ID });
  });

  const refused: Array<[string, TokenOverrides]> = [
    ['wrong issuer', { claims: { iss: 'https://auth.arcanada.one' } }],
    ['issuer with a trailing slash', { claims: { iss: 'https://auth.arcanada.ai/' } }],
    ['missing issuer', { claims: { iss: undefined } }],
    ['wrong audience', { claims: { aud: 'https://auth.arcanada.one/api/v1/admin' } }],
    ['missing audience', { claims: { aud: undefined } }],
    ['audience list with a second resource', {
      claims: { aud: ['urn:arcanada:muneral:api', 'urn:arcanada:scrutator:ltm'] },
    }],
    ['wrong token type', { header: { typ: 'JWT' } }],
    ['missing token type', { header: { typ: undefined } }],
    ['wrong client_id', { claims: { client_id: 'arc_munera_prod' } }],
    ['missing client_id', { claims: { client_id: undefined } }],
    ['missing scope', { claims: { scope: undefined } }],
    ['scope that only contains the required one as a substring', {
      claims: { scope: 'openid muneral:api-read xmuneral:api' },
    }],
    ['scope as a list', { claims: { scope: ['muneral:api'] } }],
    ['sub that is not a UUID', { claims: { sub: 'user-1' } }],
    ['sub equal to client_id', { claims: { sub: 'arc_muneral_web' } }],
    ['missing sub', { claims: { sub: undefined } }],
    ['expired', { claims: { exp: now() - 60 } }],
    ['missing exp', { claims: { exp: undefined } }],
    ['not yet valid', { claims: { nbf: now() + 600 } }],
    ['unknown kid', { header: { kid: 'some-other-key' } }],
  ];

  it.each(refused)('refuses: %s', async (_name, overrides) => {
    const token = await mintAccessToken(issuer, overrides);

    await expect(verify(token)).rejects.toBeInstanceOf(ArcanaTokenRejected);
  });

  it('refuses an ID token for the same user', async () => {
    const idToken = await mintAccessToken(issuer, {
      header: { typ: 'JWT' },
      claims: { aud: 'arc_muneral_web', client_id: undefined, scope: undefined, nonce: 'n' },
    });

    await expect(verify(idToken)).rejects.toBeInstanceOf(ArcanaTokenRejected);
  });

  it('refuses a signature made with another key under the published kid', async () => {
    const other = await createIssuer(issuer.kid);
    const token = await mintAccessToken(other);

    await expect(verify(token)).rejects.toBeInstanceOf(ArcanaTokenRejected);
  });

  it('refuses HS256 signed with the public key, without fetching any key', async () => {
    const publicPem = await exportSPKI(issuer.keys.publicKey as Parameters<typeof exportSPKI>[0]);
    const token = await mintAccessToken(issuer, {
      header: { alg: 'HS256' },
      key: new TextEncoder().encode(publicPem),
    });

    await expect(verify(token)).rejects.toBeInstanceOf(ArcanaTokenRejected);
    expect(jwks.hits()).toBe(0);
  });

  it('refuses RS256 even from a correctly signed token', async () => {
    const rsa = await generateKeyPair('RS256');
    const token = await mintAccessToken(issuer, { header: { alg: 'RS256' }, key: rsa.privateKey });

    await expect(verify(token)).rejects.toBeInstanceOf(ArcanaTokenRejected);
  });

  it('refuses an unsigned token', async () => {
    const token = new UnsecuredJWT({ sub: ARCANA_USER_ID }).encode();

    await expect(verify(token)).rejects.toBeInstanceOf(ArcanaTokenRejected);
  });

  it.each(['', 'not-a-token', 'mun_sk_x'])('refuses the non-JWT %p', async (token) => {
    await expect(verify(token)).rejects.toBeInstanceOf(ArcanaTokenRejected);
    expect(unverifiedAlgorithm(token)).toBeUndefined();
  });

  it('reports a failing key endpoint as unavailable keys, not as a bad token', async () => {
    jwks.fail(true);
    const token = await mintAccessToken(issuer);

    await expect(verify(token)).rejects.toBeInstanceOf(ArcanaKeysUnavailable);
  });

  it('reports an unreachable key endpoint as unavailable keys', async () => {
    const keys = jwks.keySource();
    await jwks.close();
    const token = await mintAccessToken(issuer);

    await expect(verifyArcanaAccessToken(token, keys)).rejects.toBeInstanceOf(ArcanaKeysUnavailable);
  });

  it('keeps verifying with cached keys while the key endpoint fails', async () => {
    const keys = jwks.keySource();
    await verifyArcanaAccessToken(await mintAccessToken(issuer), keys);
    jwks.fail(true);

    await expect(
      verifyArcanaAccessToken(await mintAccessToken(issuer), keys),
    ).resolves.toMatchObject({ sub: ARCANA_USER_ID });
    expect(jwks.hits()).toBe(1);
  });

  it('refetches at most once per cooldown for unknown kids', async () => {
    const keys = jwks.keySource({ cooldownDuration: 60_000 });
    await verifyArcanaAccessToken(await mintAccessToken(issuer), keys);

    for (const kid of ['a', 'b', 'c', 'd']) {
      const token = await mintAccessToken(issuer, { header: { kid } });
      await expect(verifyArcanaAccessToken(token, keys)).rejects.toBeInstanceOf(ArcanaTokenRejected);
    }

    expect(jwks.hits()).toBe(1);
  });

  it('does not sign anything itself with the legacy secret', async () => {
    const token = await new SignJWT({ sub: ARCANA_USER_ID, type: 'access' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));

    await expect(verify(token)).rejects.toBeInstanceOf(ArcanaTokenRejected);
  });
});

describe('arcanaKeySourceFromEnv — the switch', () => {
  const logger = () => ({ warn: jest.fn() });

  it.each([undefined, '', 'false'])('is off without a warning for %p', (value) => {
    const log = logger();

    expect(arcanaKeySourceFromEnv({ AUTH_ARCANA_ENABLED: value }, log)).toBeNull();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it.each(['1', 'TRUE', 'yes', 'true '])('stays off, does not throw and names only the variable for %p', (value) => {
    const log = logger();

    expect(arcanaKeySourceFromEnv({ AUTH_ARCANA_ENABLED: value }, log)).toBeNull();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(String(log.warn.mock.calls[0][0])).toContain('AUTH_ARCANA_ENABLED');
    expect(String(log.warn.mock.calls[0][0])).not.toContain(`"${value}"`);
  });

  it('is on for exactly "true", with no network call at construction', () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');

    const keys = arcanaKeySourceFromEnv({ AUTH_ARCANA_ENABLED: 'true' }, logger());

    expect(typeof keys).toBe('function');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('takes the key URL from the code, whatever else the environment says', () => {
    expect(ARCANA_JWKS_URL).toBe('https://auth.arcanada.ai/.well-known/jwks.json');
  });
});
