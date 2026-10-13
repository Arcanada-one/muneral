import { SECRET_RULE_IDS, ruleById, sha256Hex, spansOfRule } from '../src/tasks/redactions/secret-rules.js';

import * as rules from '../src/tasks/redactions/secret-rules.js';
const redactSpans = (rules as unknown as { redactSpans: (text: string, target: ReturnType<typeof spansOfRule>[number], replacement: string) => string }).redactSpans;

const VALUE = 'Zq3TbWxPnLdRvKJ8FheApcNyUgMsBtVxHwEzQrLm';
const MARKER = '[REDACTED generic-entropy DEC-AUP-0049 A6]';

describe('A6 generic-entropy redaction parity', () => {
  it('accepts the scanner rule and names the captured value hash, not the assignment', () => {
    expect(SECRET_RULE_IDS).toContain('generic-entropy');
    const spans = spansOfRule(ruleById('generic-entropy')!, `api_token="${VALUE}"`);
    expect(spans).toMatchObject([{ sha256: sha256Hex(VALUE), spanText: VALUE, occurrences: 1 }]);
    expect(spans[0].sha256).not.toBe(sha256Hex(`api_token="${VALUE}"`));
  });

  it('retains the exact entropy threshold and does not redact plain or low-entropy strings', () => {
    expect(spansOfRule(ruleById('generic-entropy')!, `api_token="${'a'.repeat(40)}"`)).toEqual([]);
    expect(spansOfRule(ruleById('generic-entropy')!, `api_token="${sha256Hex('synthetic')}"`)).toEqual([]);
    expect(spansOfRule(ruleById('generic-entropy')!, VALUE)).toEqual([]);
  });

  it('changes only matched value occurrences, retaining keys, quotes and unmatched identical prose', () => {
    const text = `public ${VALUE}; api_token="${VALUE}"; other_token='${VALUE}'`;
    const spans = spansOfRule(ruleById('generic-entropy')!, text);
    expect(spans[0].occurrences).toBe(2);
    expect(redactSpans(text, spans[0], MARKER)).toBe(`public ${VALUE}; api_token="${MARKER}"; other_token='${MARKER}'`);
  });

  it.each(['ключ', '密钥', 'éé', '𝟙𝟚'])('matches the original Unicode key %s', key => {
    const spans = spansOfRule(ruleById('generic-entropy')!, `${key}="${VALUE}"`);
    expect(spans).toHaveLength(1);
    expect(spans[0].sha256).toBe(sha256Hex(VALUE));
  });

  it('uses the scanner Unicode version and whitespace table, not Node17 defaults', () => {
    // Node17 recognizes U+1C89, but the pinned Python15 scanner does not.
    expect(spansOfRule(ruleById('generic-entropy')!, `\u{1c89}\u{1c89}="${VALUE}"`)).toEqual([]);
    expect(spansOfRule(ruleById('generic-entropy')!, `api_token=\ufeff"${VALUE}"`)).toEqual([]);
    expect(spansOfRule(ruleById('generic-entropy')!, `api_token=\u001f"${VALUE}"`)).toHaveLength(1);
  });

  it('uses actual capture offsets when the key repeats the same value', () => {
    const text = `${VALUE}="${VALUE}"`;
    expect(redactSpans(text, spansOfRule(ruleById('generic-entropy')!, text)[0], MARKER))
      .toBe(`${VALUE}="${MARKER}"`);
  });

  it.each(['\n', '\r', '\r\n', '\u2028', '\u0085'])('matches the Python line boundary %j', separator => {
    expect(spansOfRule(ruleById('generic-entropy')!, `api_token=${separator}"${VALUE}"`)).toEqual([]);
    const text = `public${separator}api_token="${VALUE}"`;
    expect(redactSpans(text, spansOfRule(ruleById('generic-entropy')!, text)[0], MARKER))
      .toBe(`public${separator}api_token="${MARKER}"`);
  });

  it('preserves the six critical rules and their whole-span redaction behavior', () => {
    const token = 'hvs.' + 'SyntheticTestToken' + '0'.repeat(10);
    const text = `before ${token} and ${token} after`;
    const spans = spansOfRule(ruleById('vault-token-hvs')!, text);
    expect(spans[0].occurrences).toBe(2);
    expect(redactSpans(text, spans[0], MARKER)).toBe(`before ${MARKER} and ${MARKER} after`);
  });
});
