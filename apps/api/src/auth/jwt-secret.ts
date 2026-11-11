/**
 * The one place the API reads its JWT signing secret.
 *
 * There is deliberately NO default: a secret with a public fallback value lets
 * anyone who has read the source forge access tokens. When `JWT_SECRET` is unset
 * or blank the process refuses to start. The message names the variable only,
 * never a value.
 */
export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (secret === undefined || secret.trim() === '') {
    throw new Error('JWT_SECRET is not set: refusing to start without a JWT signing secret');
  }
  return secret;
}
