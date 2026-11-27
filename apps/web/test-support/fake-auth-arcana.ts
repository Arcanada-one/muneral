/** A stand-in for Auth Arcana behind a stubbed fetch. All keys are generated while the test runs. */
import { createHash, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';

export const ISSUER = 'https://auth.arcanada.ai';
export const CLIENT_ID = 'arc_muneral_web';
export const APP = 'https://app.example.test';
export const SUBJECT = '0197a000-0000-7000-8000-000000000001';

const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
const decode = (value: string) => JSON.parse(Buffer.from(value, 'base64url').toString()) as Record<string, any>;

/** The stand-in's ID token key. One per test file, because the application caches the key set. */
const providerSigning = generateKeyPairSync('ed25519');
export const SIGNING_KID = 'stand-in-signing-1';
export const SIGNING_JWK = {
  ...providerSigning.publicKey.export({ format: 'jwk' }), kid: SIGNING_KID, alg: 'EdDSA', use: 'sig',
};
/** A key the stand-in does not publish. */
const strangerSigning = generateKeyPairSync('ed25519');

export interface IdTokenSpoil {
  alg?: string;
  kid?: string;
  /** Signed with a key that is not in the published set. */
  foreignKey?: boolean;
  claims?: Record<string, unknown>;
}

export function standInIdToken(claims: object, spoil: IdTokenSpoil = {}): string {
  const alg = spoil.alg ?? 'EdDSA';
  const input = `${part({ alg, typ: 'JWT', kid: spoil.kid ?? SIGNING_KID })}.${part({ ...claims, ...spoil.claims })}`;
  if (alg === 'none') return `${input}.`;
  const key = (spoil.foreignKey ? strangerSigning : providerSigning).privateKey;
  return `${input}.${sign(null, Buffer.from(input), key).toString('base64url')}`;
}

export function clientKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { publicKey, pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}

export interface TokenCall {
  body: URLSearchParams;
  assertion?: { header: Record<string, any>; claims: Record<string, any>; signatureValid: boolean };
}

export class FakeAuth {
  readonly calls: TokenCall[] = [];
  readonly requested: string[] = [];
  private issued = 0;
  /** What the next authorization-code exchange and ID token should look like. */
  challenge = '';
  nonce: string | undefined = '';
  idToken: IdTokenSpoil = {};
  /** Set to make a refresh response carry an ID token, spoiled as given. */
  refreshIdToken: IdTokenSpoil | undefined;
  /** Changes to the discovery document and to the published key set. */
  discovery: { status?: number; patch?: Record<string, unknown> } = {};
  jwks: { status?: number; keys?: object[]; unreachable?: boolean } = {};
  accessLifetime = 300;
  refreshBehaviour: 'ok' | 'invalid_grant' | 'network' | 'server_error' = 'ok';
  refreshGate: Promise<void> | undefined;
  /** Refresh tokens already spent: presenting one again is reuse. */
  readonly spent = new Set<string>();
  reuseDetected = false;

  constructor(private readonly clientPublicKey: KeyObject) {}

  private tokens(spoil: IdTokenSpoil | undefined, withNonce = false) {
    const n = ++this.issued;
    const now = Math.floor(Date.now() / 1000);
    return {
      token_type: 'bearer',
      access_token: `fake-access-${n}`,
      refresh_token: `fake-refresh-${n}`,
      expires_in: this.accessLifetime,
      ...(spoil
        ? {
            id_token: standInIdToken(
              {
                iss: ISSUER, aud: CLIENT_ID, sub: SUBJECT, iat: now, exp: now + 300,
                ...(withNonce && this.nonce !== undefined ? { nonce: this.nonce } : {}),
              },
              spoil,
            ),
          }
        : {}),
    };
  }

  private readAssertion(body: URLSearchParams): TokenCall['assertion'] {
    const value = body.get('client_assertion');
    if (!value) return undefined;
    const [header, claims, signature] = value.split('.');
    return {
      header: decode(header),
      claims: decode(claims),
      signatureValid: verify(null, Buffer.from(`${header}.${claims}`), this.clientPublicKey,
        Buffer.from(signature, 'base64url')),
    };
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    this.requested.push(url);
    const json = (body: object, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/oidc/auth`,
        token_endpoint: `${ISSUER}/oidc/token`,
        userinfo_endpoint: `${ISSUER}/oidc/me`,
        jwks_uri: `${ISSUER}/oidc/jwks`,
        end_session_endpoint: `${ISSUER}/oidc/logout`,
        code_challenge_methods_supported: ['S256'],
        id_token_signing_alg_values_supported: ['EdDSA'],
        ...this.discovery.patch,
      }, this.discovery.status);
    }
    if (url === `${ISSUER}/oidc/jwks`) {
      if (this.jwks.unreachable) throw new TypeError('fetch failed');
      return json({ keys: this.jwks.keys ?? [SIGNING_JWK] }, this.jwks.status);
    }
    if (url !== `${ISSUER}/oidc/token`) throw new Error(`Unexpected request in test: ${url}`);
    const body = new URLSearchParams(String(init?.body));
    this.calls.push({ body, assertion: this.readAssertion(body) });
    if (body.get('grant_type') === 'authorization_code') {
      const proof = createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url');
      if (proof !== this.challenge) return json({ error: 'invalid_grant' }, 400);
      return json(this.tokens(this.idToken, true));
    }
    await this.refreshGate;
    if (this.refreshBehaviour === 'network') throw new TypeError('fetch failed');
    if (this.refreshBehaviour === 'server_error') return json({ error: 'server_error' }, 503);
    const presented = body.get('refresh_token') ?? '';
    if (this.spent.has(presented)) {
      this.reuseDetected = true;
      return json({ error: 'invalid_grant' }, 400);
    }
    if (this.refreshBehaviour === 'invalid_grant') return json({ error: 'invalid_grant' }, 400);
    this.spent.add(presented);
    return json(this.tokens(this.refreshIdToken));
  };
}
