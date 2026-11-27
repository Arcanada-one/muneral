/**
 * Test support for Auth Arcana access tokens: keys generated per run, and a JWKS endpoint on
 * loopback that counts its requests and can be made to fail. Nothing here is a real credential.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRemoteJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';

export const ARCANA_USER_ID = '0192f0c1-7a2b-7c3d-8e4f-5a6b7c8d9e0f';
export const LOCAL_USER_ID = '5b7f2c9e-1d34-4a86-9f02-6c8e1b4a7d93';

type Keys = Awaited<ReturnType<typeof generateKeyPair>>;

export interface Issuer {
  kid: string;
  keys: Keys;
  publicJwk: JWK;
}

export async function createIssuer(kid = 'test-ed25519-1', alg = 'EdDSA'): Promise<Issuer> {
  const keys = await generateKeyPair(alg, { extractable: true });
  const publicJwk = { ...(await exportJWK(keys.publicKey)), kid, alg, use: 'sig' };
  return { kid, keys, publicJwk };
}

export interface TokenOverrides {
  /** Claims to replace; a value of `undefined` removes the claim. */
  claims?: Record<string, unknown>;
  /** Protected header fields to replace; a value of `undefined` removes the field. */
  header?: Record<string, unknown>;
  key?: Parameters<SignJWT['sign']>[0];
}

function without(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

export async function mintAccessToken(
  issuer: Issuer,
  overrides: TokenOverrides = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims = without({
    iss: 'https://auth.arcanada.ai',
    aud: 'urn:arcanada:muneral:api',
    sub: ARCANA_USER_ID,
    client_id: 'arc_muneral_web',
    scope: 'openid offline_access muneral:api',
    iat: now,
    exp: now + 300,
    jti: 'test-jti',
    ...overrides.claims,
  });
  const header = without({ alg: 'EdDSA', typ: 'at+jwt', kid: issuer.kid, ...overrides.header });
  return new SignJWT(claims)
    .setProtectedHeader(header as { alg: string })
    .sign(overrides.key ?? issuer.keys.privateKey);
}

export interface JwksServer {
  /** Requests received so far. */
  hits(): number;
  /** Answer 500 from now on (`true`), or serve the keys again (`false`). */
  fail(value: boolean): void;
  keySource(options?: { cooldownDuration?: number }): ReturnType<typeof createRemoteJWKSet>;
  close(): Promise<void>;
}

export async function startJwksServer(issuer: Issuer): Promise<JwksServer> {
  let hits = 0;
  let failing = false;
  const server: Server = createServer((_request, response) => {
    hits += 1;
    if (failing) {
      response.writeHead(500).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
    response.end(JSON.stringify({ keys: [issuer.publicJwk] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const url = new URL(`http://127.0.0.1:${port}/jwks.json`);

  return {
    hits: () => hits,
    fail: (value) => {
      failing = value;
    },
    keySource: (options) => createRemoteJWKSet(url, { timeoutDuration: 2_000, ...options }),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
