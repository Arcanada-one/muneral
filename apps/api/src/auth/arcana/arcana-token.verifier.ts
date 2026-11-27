/**
 * Verification of Auth Arcana access tokens (RFC 9068 `at+jwt`) for the Muneral API.
 *
 * This verifier accepts exactly one shape and shares nothing with the legacy HS256 verifier: it
 * pins its own algorithm and takes its keys only from the key source it is given. The trust values
 * are constants on purpose, so no environment variable can point the API at another issuer or key
 * set. See docs/reference/auth-arcana-access-tokens.md.
 */
import { decodeProtectedHeader, errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';

export const ARCANA_ISSUER = 'https://auth.arcanada.ai';
export const ARCANA_JWKS_URL = 'https://auth.arcanada.ai/.well-known/jwks.json';
export const ARCANA_AUDIENCE = 'urn:arcanada:muneral:api';
export const ARCANA_SCOPE = 'muneral:api';
export const ARCANA_CLIENT_ID = 'arc_muneral_web';
export const ARCANA_ALGORITHM = 'EdDSA';
export const ARCANA_TOKEN_TYPE = 'at+jwt';

/** Allowed clock difference between the issuer and this host, for `exp` and `nbf`. */
const CLOCK_TOLERANCE_SECONDS = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The token itself is not acceptable. */
export class ArcanaTokenRejected extends Error {}

/** The signing keys could not be obtained, so nothing is known about the token. Retryable. */
export class ArcanaKeysUnavailable extends Error {}

export interface ArcanaAccessToken {
  /** Auth Arcana `user.id`. */
  sub: string;
  /** `exp`, in seconds since the epoch. */
  expiresAt: number;
}

/** jose error codes that describe the token. Anything else is a failure to obtain keys. */
const TOKEN_ERROR_CODES: ReadonlySet<string> = new Set([
  errors.JWTClaimValidationFailed.code,
  errors.JWTExpired.code,
  errors.JWTInvalid.code,
  errors.JWSInvalid.code,
  errors.JWSSignatureVerificationFailed.code,
  errors.JOSEAlgNotAllowed.code,
  errors.JOSENotSupported.code,
  errors.JWKSNoMatchingKey.code,
  errors.JWKSMultipleMatchingKeys.code,
]);

/**
 * The `alg` of the UNVERIFIED protected header. It only chooses which verifier sees the token;
 * it never authenticates anything.
 */
export function unverifiedAlgorithm(token: string): string | undefined {
  try {
    const { alg } = decodeProtectedHeader(token);
    return typeof alg === 'string' ? alg : undefined;
  } catch {
    return undefined;
  }
}

export async function verifyArcanaAccessToken(
  token: string,
  keys: JWTVerifyGetKey,
): Promise<ArcanaAccessToken> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, keys, {
      algorithms: [ARCANA_ALGORITHM],
      typ: ARCANA_TOKEN_TYPE,
      issuer: ARCANA_ISSUER,
      audience: ARCANA_AUDIENCE,
      requiredClaims: ['exp', 'sub', 'client_id', 'scope'],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    }));
  } catch (error) {
    if (error instanceof errors.JOSEError && TOKEN_ERROR_CODES.has(error.code)) {
      throw new ArcanaTokenRejected(error.code);
    }
    throw new ArcanaKeysUnavailable('Auth Arcana signing keys are unavailable');
  }

  const { sub, exp, aud, client_id: clientId, scope } = payload;
  // jose accepts any audience list that CONTAINS ours; a token for several resources is refused.
  if (Array.isArray(aud) && aud.length !== 1) throw new ArcanaTokenRejected('audience');
  if (clientId !== ARCANA_CLIENT_ID) throw new ArcanaTokenRejected('client_id');
  if (typeof scope !== 'string' || !scope.split(' ').includes(ARCANA_SCOPE)) {
    throw new ArcanaTokenRejected('scope');
  }
  // A client-credentials token has `sub` equal to `client_id`; only a user may sign in.
  if (typeof sub !== 'string' || sub === clientId || !UUID.test(sub)) {
    throw new ArcanaTokenRejected('sub');
  }
  if (typeof exp !== 'number') throw new ArcanaTokenRejected('exp');

  return { sub: sub.toLowerCase(), expiresAt: exp };
}
