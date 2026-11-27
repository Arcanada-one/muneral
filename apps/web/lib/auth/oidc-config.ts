/**
 * Server-only settings of the Auth Arcana OIDC client. Muneral web signs users in through Auth
 * Arcana and nothing else. With any setting absent or invalid the client is off: no provider is
 * registered. Nothing is read at import or build time.
 */
export const AUTH_ARCANA_ISSUER = 'https://auth.arcanada.ai';
export const API_RESOURCE = 'urn:arcanada:muneral:api';
export const SCOPES = 'openid offline_access muneral:api';
export const PROVIDER_ID = 'arcanada';

export interface OidcConfig {
  issuer: string;
  clientId: string;
  /** Ed25519 signing key for private_key_jwt client authentication; not extractable. */
  privateKey: CryptoKey;
  keyId?: string;
  /** Public origin of this web application, from configuration and never from request headers. */
  appOrigin: string;
}

type Environment = Record<string, string | undefined>;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function parseAppOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const secure = url.protocol === 'https:' ||
      (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
    return secure && url.href === `${url.origin}/` ? url.origin : null;
  } catch {
    return null;
  }
}

async function importSigningKey(pem: string): Promise<CryptoKey | null> {
  const match = /^-----BEGIN PRIVATE KEY-----([A-Za-z0-9+/=\s]+)-----END PRIVATE KEY-----$/.exec(
    pem.replace(/\\n/g, '\n').trim(),
  );
  if (!match) return null;
  try {
    const der = Uint8Array.from(Buffer.from(match[1].replace(/\s/g, ''), 'base64'));
    return await crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, false, ['sign']);
  } catch {
    return null;
  }
}

export async function readOidcConfig(env: Environment): Promise<OidcConfig | null> {
  const issuer = env.AUTH_ARCANA_ISSUER;
  const clientId = env.AUTH_ARCANA_CLIENT_ID;
  const pem = env.AUTH_ARCANA_CLIENT_PRIVATE_KEY;
  if (!issuer && !clientId && !pem) return null;

  const appOrigin = parseAppOrigin(env.AUTH_URL ?? env.NEXTAUTH_URL);
  const privateKey = pem ? await importSigningKey(pem) : null;
  const invalid = [
    issuer === AUTH_ARCANA_ISSUER ? null : 'AUTH_ARCANA_ISSUER',
    clientId ? null : 'AUTH_ARCANA_CLIENT_ID',
    privateKey ? null : 'AUTH_ARCANA_CLIENT_PRIVATE_KEY',
    appOrigin ? null : 'AUTH_URL',
    env.NEXTAUTH_SECRET ? null : 'NEXTAUTH_SECRET',
  ].filter(Boolean);
  if (invalid.length > 0 || !issuer || !clientId || !privateKey || !appOrigin) {
    // Names only: a value must never reach a log.
    console.warn(`Auth Arcana sign-in is off; missing or invalid: ${invalid.join(', ')}`);
    return null;
  }
  return { issuer, clientId, privateKey, appOrigin, keyId: env.AUTH_ARCANA_CLIENT_KEY_ID || undefined };
}

let loaded: Promise<OidcConfig | null> | undefined;

/** The process-wide configuration, read once on first use. */
export function loadOidcConfig(): Promise<OidcConfig | null> {
  loaded ??= readOidcConfig(process.env);
  return loaded;
}
