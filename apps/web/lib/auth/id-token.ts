/**
 * Verification of an ID token against the issuer's published keys, with WebCrypto, as the client
 * assertion is signed. Only EdDSA over Ed25519 is accepted. The nonce is not checked here:
 * Auth.js alone holds the expected value and checks it.
 *
 * Error messages name the failed check and never carry the token or a claim value.
 */
const TIMEOUT_MS = 10_000;
const CLOCK_TOLERANCE_SECONDS = 30;
/** A key set is read again after this long, so that a withdrawn key stops being accepted. */
export const KEY_SET_MAX_AGE_MS = 10 * 60_000;
/** An unknown key id reads the set again (key rotation), at most once in this long. */
export const KEY_SET_COOLDOWN_MS = 30_000;

export class IdTokenRejected extends Error {
  constructor(reason: string) {
    super(`ID token rejected: ${reason}`);
    this.name = 'IdTokenRejected';
  }
}

interface PublishedKey {
  kty?: unknown;
  crv?: unknown;
  x?: unknown;
  kid?: unknown;
  alg?: unknown;
  use?: unknown;
  key_ops?: unknown;
}

interface KeySet {
  keys: PublishedKey[];
  readAt: number;
}

const keySets = new Map<string, KeySet>();

async function readKeySet(jwksUri: string): Promise<KeySet> {
  const response = await fetch(jwksUri, {
    // A redirect could lead away from the issuer.
    redirect: 'manual',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status !== 200) throw new IdTokenRejected('key set unavailable');
  const body = (await response.json()) as { keys?: unknown };
  if (!Array.isArray(body.keys)) throw new IdTokenRejected('key set unavailable');
  const set = { keys: body.keys as PublishedKey[], readAt: Date.now() };
  keySets.set(jwksUri, set);
  return set;
}

const matches = (key: PublishedKey | null, kid: string): key is PublishedKey & { x: string } =>
  !!key &&
  key.kid === kid &&
  key.kty === 'OKP' &&
  key.crv === 'Ed25519' &&
  typeof key.x === 'string' &&
  (key.alg === undefined || key.alg === 'EdDSA') &&
  (key.use === undefined || key.use === 'sig') &&
  (key.key_ops === undefined || (Array.isArray(key.key_ops) && key.key_ops.includes('verify')));

async function publishedKey(jwksUri: string, kid: string): Promise<CryptoKey> {
  let set = keySets.get(jwksUri);
  if (!set || Date.now() - set.readAt >= KEY_SET_MAX_AGE_MS) set = await readKeySet(jwksUri);
  let found = set.keys.filter((key) => matches(key, kid));
  if (found.length === 0 && Date.now() - set.readAt >= KEY_SET_COOLDOWN_MS) {
    found = (await readKeySet(jwksUri)).keys.filter((key) => matches(key, kid));
  }
  if (found.length !== 1) throw new IdTokenRejected('unknown key');
  // Only the public members are passed on.
  const { x } = found[0] as { x: string };
  return crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x }, { name: 'Ed25519' }, false, ['verify']);
}

function decodeObject(part: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // Reported below.
  }
  throw new IdTokenRejected('malformed');
}

export async function verifySignedIdToken(
  idToken: string,
  expected: { jwksUri: string; issuer: string; audience: string },
): Promise<void> {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new IdTokenRejected('malformed');
  const header = decodeObject(parts[0]);
  if (header.alg !== 'EdDSA') throw new IdTokenRejected('algorithm');
  // No critical header extension is understood here, so any is refused (RFC 7515 4.1.11).
  if (header.crit !== undefined) throw new IdTokenRejected('critical header');
  if (typeof header.kid !== 'string' || !header.kid) throw new IdTokenRejected('unknown key');

  const valid = await crypto.subtle.verify(
    { name: 'Ed25519' },
    await publishedKey(expected.jwksUri, header.kid),
    Buffer.from(parts[2], 'base64url'),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) throw new IdTokenRejected('signature');

  const claims = decodeObject(parts[1]);
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== expected.issuer) throw new IdTokenRejected('issuer');
  const audiences: unknown[] = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(expected.audience)) throw new IdTokenRejected('audience');
  if (typeof claims.exp !== 'number' || claims.exp <= now - CLOCK_TOLERANCE_SECONDS) {
    throw new IdTokenRejected('expiry');
  }
  if (
    claims.nbf !== undefined &&
    (typeof claims.nbf !== 'number' || claims.nbf > now + CLOCK_TOLERANCE_SECONDS)
  ) {
    throw new IdTokenRejected('not yet valid');
  }
}
