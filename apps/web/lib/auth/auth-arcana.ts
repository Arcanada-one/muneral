/** The calls this server makes to Auth Arcana itself: client assertion, discovery and refresh. */
import { API_RESOURCE, type OidcConfig } from './oidc-config';

const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const TIMEOUT_MS = 10_000;

const encodePart = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * private_key_jwt assertion. One signer serves both grants: header alg `EdDSA` and a single string
 * audience. (Auth.js would send alg `Ed25519` with an audience array.)
 */
export async function signClientAssertion(config: OidcConfig, now = Date.now()): Promise<string> {
  const issuedAt = Math.floor(now / 1000);
  const header = { alg: 'EdDSA', typ: 'JWT', ...(config.keyId ? { kid: config.keyId } : {}) };
  const payload = {
    iss: config.clientId,
    sub: config.clientId,
    aud: config.issuer,
    jti: crypto.randomUUID(),
    iat: issuedAt,
    nbf: issuedAt,
    exp: issuedAt + 60,
  };
  const input = `${encodePart(header)}.${encodePart(payload)}`;
  const signature = await crypto.subtle.sign(
    { name: 'Ed25519' },
    config.privateKey,
    new TextEncoder().encode(input),
  );
  return `${input}.${Buffer.from(signature).toString('base64url')}`;
}

async function authenticate(config: OidcConfig, body: URLSearchParams): Promise<void> {
  body.set('client_id', config.clientId);
  body.set('client_assertion_type', ASSERTION_TYPE);
  body.set('client_assertion', await signClientAssertion(config));
  body.set('resource', API_RESOURCE);
}

/**
 * Fetch used by Auth.js. On the authorization-code token request it names the API resource and
 * replaces the client assertion; every other request passes through unchanged.
 */
export function tokenRequestFetch(config: OidcConfig): typeof fetch {
  return async (input, init) => {
    const body = init?.body;
    if (body instanceof URLSearchParams && body.get('grant_type') === 'authorization_code') {
      await authenticate(config, body);
    }
    return fetch(input, init);
  };
}

export interface Endpoints {
  tokenEndpoint: string;
  endSessionEndpoint?: string;
}

const discovered = new Map<string, Promise<Endpoints>>();

async function fetchEndpoints(issuer: string): Promise<Endpoints> {
  const response = await fetch(`${issuer}/.well-known/openid-configuration`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error('Discovery failed');
  const metadata = (await response.json()) as Record<string, unknown>;
  const sameOrigin = (value: unknown): value is string =>
    typeof value === 'string' && value.startsWith(`${issuer}/`);
  if (metadata.issuer !== issuer || !sameOrigin(metadata.token_endpoint)) {
    throw new Error('Unexpected discovery document');
  }
  return {
    tokenEndpoint: metadata.token_endpoint,
    endSessionEndpoint: sameOrigin(metadata.end_session_endpoint)
      ? metadata.end_session_endpoint
      : undefined,
  };
}

export function discover(config: OidcConfig): Promise<Endpoints> {
  let pending = discovered.get(config.issuer);
  if (!pending) {
    pending = fetchEndpoints(config.issuer).catch((error: unknown) => {
      discovered.delete(config.issuer);
      throw error;
    });
    discovered.set(config.issuer, pending);
  }
  return pending;
}

export interface RefreshedTokens {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresInSeconds: number;
}

/** Auth refused the grant: the login is over. Any other failure is treated as temporary. */
export class RefreshRefused extends Error {
  constructor() {
    super('The refresh grant was refused');
    this.name = 'RefreshRefused';
  }
}

export async function refreshTokens(
  config: OidcConfig,
  refreshToken: string,
): Promise<RefreshedTokens> {
  const { tokenEndpoint } = await discover(config);
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken });
  await authenticate(config, body);
  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (response.status === 400 && data.error === 'invalid_grant') throw new RefreshRefused();
  if (!response.ok || typeof data.access_token !== 'string' || !data.access_token) {
    // The response body is not repeated: it may carry tokens.
    throw new Error(`Refresh failed with status ${response.status}`);
  }
  return {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
    idToken: typeof data.id_token === 'string' ? data.id_token : undefined,
    expiresInSeconds:
      typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : 300,
  };
}
