import { createHash } from 'node:crypto';

// Candidate commands receive only owned fixture credentials. Redact them anyway;
// keep bounded failure evidence in the artifact instead of dumping subprocess logs.
/** @param {unknown} error */
export function commandFailureEvidence(error) {
  /** @param {unknown} value */
  const redact = value => String(value ?? '')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[redacted private key]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/(?:mun_sk_|gh[pousr]_)[A-Za-z0-9_-]+/g, '[redacted token]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted JWT]');
  /** @param {unknown} value */
  const describe = value => {
    const text = redact(value);
    return { text: text.slice(-8192), truncated: text.length > 8192,
      sha256: createHash('sha256').update(text).digest('hex') };
  };
  const object = typeof error === 'object' && error !== null ? error : {};
  return {
    stderr: describe('stderr' in object ? object.stderr : undefined),
    stdout: describe('stdout' in object ? object.stdout : undefined),
  };
}
