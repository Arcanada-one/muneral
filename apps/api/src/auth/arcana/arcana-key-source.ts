import { Logger } from '@nestjs/common';
import { createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';
import { ARCANA_JWKS_URL } from './arcana-token.verifier.js';

/** DI token. `null` means the Auth Arcana path is off. */
export const ARCANA_KEY_SOURCE = Symbol('ARCANA_KEY_SOURCE');

/** The one switch. Only the exact value `true` turns the Auth Arcana path on. */
export const ARCANA_SWITCH = 'AUTH_ARCANA_ENABLED';

/**
 * Never throws: the API must boot with no new variable, and a mistyped one must not stop it.
 * Creating the remote key set makes no network call; keys are fetched on the first token.
 */
export function arcanaKeySourceFromEnv(
  env: Record<string, string | undefined>,
  logger: Pick<Logger, 'warn'> = new Logger('ArcanaAuth'),
): JWTVerifyGetKey | null {
  const value = env[ARCANA_SWITCH];
  if (value === 'true') {
    return createRemoteJWKSet(new URL(ARCANA_JWKS_URL), {
      timeoutDuration: 5_000,
      // An unknown `kid` triggers at most one refetch per cooldown period.
      cooldownDuration: 30_000,
      cacheMaxAge: 600_000,
    });
  }
  if (value !== undefined && value !== '' && value !== 'false') {
    // The variable name only, never its value.
    logger.warn(`${ARCANA_SWITCH} is neither "true" nor "false": the Auth Arcana path stays off`);
  }
  return null;
}
