import { createHash } from 'node:crypto';

/**
 * MUN-0049 — the six critical and generic-entropy rules of the Scrutator `muneral-kb-sync` scanner,
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
export interface SecretRule {
  id: string;
  pattern: RegExp;
  captureGroup?: number;
  minimumEntropy?: number;
}

export const SECRET_RULES: ReadonlyArray<SecretRule> = [
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
  // A3 Finding.span_hash hashes the captured value, not the assignment.
  { id: 'generic-entropy', pattern: /([\w.\-]{2,})["']?\s*[:=]\s*["']([A-Za-z0-9+/=_\-]{20,})["']/g,
    captureGroup: 2, minimumEntropy: 4.0 },
];

export const SECRET_RULE_IDS: ReadonlyArray<string> = SECRET_RULES.map((r) => r.id);

/** The scanner's generic-entropy rule: a quoted assignment whose value has
 *  Shannon entropy above 4.0 bits per character. Mirrored so a replacement
 *  text cannot itself be something the sync would block. */

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

export function ruleById(id: string): SecretRule | undefined {
  return SECRET_RULES.find((r) => r.id === id);
}

/** Every distinct span the rule matches in `text`, in order of first sighting,
 *  as (sha256, occurrence count). Cleartext never leaves this function's
 *  caller boundary except through `spanText`, which the service uses only to
 *  perform the replacement. */
export interface SecretSpan {
  sha256: string;
  spanText: string;
  occurrences: number;
  ranges?: Array<{ start: number; end: number }>;
}

export function spansOfRule(
  rule: Pick<SecretRule, 'pattern' | 'captureGroup' | 'minimumEntropy'>,
  text: string,
): SecretSpan[] {
  const group = rule.captureGroup ?? 0;
  const flags = group > 0 && !rule.pattern.flags.includes('d')
    ? rule.pattern.flags + 'd' : rule.pattern.flags;
  const pattern = new RegExp(rule.pattern.source, flags);
  const seen = new Map<string, SecretSpan>();
  // Python's scanner applies each entropy assignment pattern per splitlines().
  const segments = group > 0
    ? [...text.matchAll(/[^\r\n\v\f\u001c-\u001e\u0085\u2028\u2029]+/g)].map(m => ({ text: m[0], offset: m.index! }))
    : [{ text, offset: 0 }];
  for (const segment of segments) {
   for (const m of segment.text.matchAll(pattern)) {
    const span = m[group];
    if (!span || (rule.minimumEntropy !== undefined && shannonEntropy(span) <= rule.minimumEntropy)) continue;
    const key = sha256Hex(span);
    let entry = seen.get(key);
    if (entry) entry.occurrences += 1;
    else {
      entry = { sha256: key, spanText: span, occurrences: 1 };
      if (group > 0) entry.ranges = [];
      seen.set(key, entry);
    }
    if (group > 0) {
      const range = m.indices?.[group];
      if (!range) throw new Error('CAPTURED_SPAN_POSITION_MISSING');
      entry.ranges!.push({ start: segment.offset + range[0], end: segment.offset + range[1] });
    }
  }
  }
  return [...seen.values()];
}

/** For captured values, replace only exact scanner occurrences. An identical
 *  value in an unrelated key or public prose is not appointed as a finding. */
export function redactSpans(text: string, target: SecretSpan, replacement: string): string {
  if (!target.ranges) return text.split(target.spanText).join(replacement);
  let next = '', position = 0;
  for (const range of target.ranges) {
    if (range.start < position || range.end > text.length || text.slice(range.start, range.end) !== target.spanText) {
      throw new Error('CAPTURED_SPAN_POSITION_CHANGED');
    }
    next += text.slice(position, range.start) + replacement;
    position = range.end;
  }
  return next + text.slice(position);
}

/** Rule ids (the six critical rules plus `generic-entropy`) that fire on
 *  `text`. Empty means the kb-sync scanner would pass it. */
export function findingsOf(text: string): string[] {
  const fired: string[] = [];
  for (const rule of SECRET_RULES) {
    if (spansOfRule(rule, text).length > 0) fired.push(rule.id);
  }
  return fired;
}
