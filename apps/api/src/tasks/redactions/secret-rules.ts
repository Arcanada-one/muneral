import { createHash } from 'node:crypto';

/**
 * MUN-0049 — the six critical rules of the Scrutator `muneral-kb-sync` scanner,
 * vendored so a redaction can be located by the SAME rule that blocked the
 * task. Source: Arcanada-one/scrutator @ c08fe654e50c11fcafca31420647e32b6c65450b
 * `tools/muneral_sync/secretscan.py`
 * (sha256 15f76187b815167b8a46b44930d4c151550d1bb56c5c2c38044c5faa1091e273).
 * Never edit a pattern here; re-vendor from Scrutator and update the digest.
 *
 * The Python scanner runs each pattern per line. None of the six can match
 * across a newline (`[^\s"']+`, `[A-Za-z0-9]+`, fixed headers), so matching
 * over the whole field value finds exactly the spans the per-line scan finds.
 * `approle-secret-id` carries re.IGNORECASE in the source, hence the `i` flag.
 */
export const SECRET_RULES: ReadonlyArray<{ id: string; pattern: RegExp }> = [
  { id: 'vault-token-hvs', pattern: /hvs\.[A-Za-z0-9]{20,}/g },
  { id: 'vault-token-legacy', pattern: /\bs\.[A-Za-z0-9]{24,}/g },
  {
    id: 'approle-secret-id',
    pattern:
      /secret_id["'\s:=]+[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
  },
  { id: 'pgpassword', pattern: /PGPASSWORD\s*=\s*["']?([^\s"']+)/g },
  { id: 'cloudflare-origin-token', pattern: /v1\.0-[A-Za-z0-9-]{100,}/g },
  { id: 'pem-private-key', pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g },
];

export const SECRET_RULE_IDS: ReadonlyArray<string> = SECRET_RULES.map((r) => r.id);

/** The scanner's generic-entropy rule: a quoted assignment whose value has
 *  Shannon entropy above 4.0 bits per character. Mirrored so a replacement
 *  text cannot itself be something the sync would block. */
const ENTROPY_ASSIGN = /([\w.\-]{2,})["']?\s*[:=]\s*["']([A-Za-z0-9+/=_\-]{20,})["']/g;
const ENTROPY_THRESHOLD = 4.0;

export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function ruleById(id: string): { id: string; pattern: RegExp } | undefined {
  return SECRET_RULES.find((r) => r.id === id);
}

/** Every distinct span the rule matches in `text`, in order of first sighting,
 *  as (sha256, occurrence count). Cleartext never leaves this function's
 *  caller boundary except through `spanText`, which the service uses only to
 *  perform the replacement. */
export function spansOfRule(
  rule: { pattern: RegExp },
  text: string,
): Array<{ sha256: string; spanText: string; occurrences: number }> {
  const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
  const seen = new Map<string, { sha256: string; spanText: string; occurrences: number }>();
  for (const m of text.matchAll(pattern)) {
    const span = m[0];
    if (span.length === 0) continue;
    const key = sha256Hex(span);
    const entry = seen.get(key);
    if (entry) entry.occurrences += 1;
    else seen.set(key, { sha256: key, spanText: span, occurrences: 1 });
  }
  return [...seen.values()];
}

/** Rule ids (the six critical rules plus `generic-entropy`) that fire on
 *  `text`. Empty means the kb-sync scanner would pass it. */
export function findingsOf(text: string): string[] {
  const fired: string[] = [];
  for (const rule of SECRET_RULES) {
    if (spansOfRule(rule, text).length > 0) fired.push(rule.id);
  }
  const entropy = new RegExp(ENTROPY_ASSIGN.source, ENTROPY_ASSIGN.flags);
  for (const m of text.matchAll(entropy)) {
    if (shannonEntropy(m[2]) > ENTROPY_THRESHOLD) {
      fired.push('generic-entropy');
      break;
    }
  }
  return fired;
}
