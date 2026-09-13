// MUN-0049: the vendored kb-sync rules behave like the Scrutator scanner on
// synthetic material, and the helpers never leak a span except to the caller
// that performs the replacement. Every "secret" below is synthetic and shaped
// to match a rule, never a real credential.
import {
  findingsOf,
  ruleById,
  SECRET_RULE_IDS,
  shannonEntropy,
  sha256Hex,
  spansOfRule,
} from '../src/tasks/redactions/secret-rules.js';

const HVS = 'hvs.' + 'SyntheticTestToken' + '0'.repeat(10);
const PGP = 'PGPASSWORD=' + 'synthetic' + 'a'.repeat(12);
const PEM = ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ');

describe('secret-rules (vendored from Scrutator muneral_sync/secretscan.py)', () => {
  it('carries exactly the six critical rule ids of the scanner', () => {
    expect([...SECRET_RULE_IDS]).toEqual([
      'vault-token-hvs',
      'vault-token-legacy',
      'approle-secret-id',
      'pgpassword',
      'cloudflare-origin-token',
      'pem-private-key',
    ]);
  });

  it.each([
    ['vault-token-hvs', `deploy with ${HVS} now`, HVS],
    ['pgpassword', `export ${PGP} ; psql`, PGP],
    ['pem-private-key', `paste ${PEM} into the box`, PEM],
  ])('%s finds the span and reports it by sha256 with its count', (id, text, span) => {
    const rule = ruleById(id)!;
    const spans = spansOfRule(rule, text);
    expect(spans).toEqual([{ sha256: sha256Hex(span), spanText: span, occurrences: 1 }]);
  });

  it('counts a repeated identical span once, with occurrences 2', () => {
    const spans = spansOfRule(ruleById('vault-token-hvs')!, `${HVS} and again ${HVS}`);
    expect(spans).toHaveLength(1);
    expect(spans[0].occurrences).toBe(2);
  });

  it('approle-secret-id is case-insensitive like the source rule', () => {
    const text = 'SECRET_ID: 00000000-0000-0000-0000-000000000000';
    expect(spansOfRule(ruleById('approle-secret-id')!, text)).toHaveLength(1);
  });

  it('findingsOf is empty on clean text and on the redaction marker itself', () => {
    expect(findingsOf('Rotate the vault token before the demo')).toEqual([]);
    expect(
      findingsOf('[REDACTED pgpassword sha256:00112233aabbccdd — removed 2026-09-13 KBSYNC-0]'),
    ).toEqual([]);
  });

  it('findingsOf names every rule that fires, plus generic-entropy on a high-entropy quoted value', () => {
    expect(findingsOf(`${HVS} ${PGP}`)).toEqual(['vault-token-hvs', 'pgpassword']);
    const highEntropy = 'aB3dE5fG7hI9jK1lM2nO4pQ6rS8tU0vW';
    expect(shannonEntropy(highEntropy)).toBeGreaterThan(4.0);
    expect(findingsOf(`token="${highEntropy}"`)).toEqual(['generic-entropy']);
    // A 64-hex digest never exceeds 4.0 bits/char, so hashes in payloads stay clean.
    expect(findingsOf(`span="${sha256Hex('x')}"`)).toEqual([]);
  });
});
