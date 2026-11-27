// @vitest-environment node
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TASK_STATUSES } from '@muneral/types';
import { DATE_LOCALE, LOCALES } from '@/lib/preferences/preferences';
import { TASK_STATUS_LABELS } from '@/lib/task-status-labels';
import { messages, plurals } from './messages';
import { scanSource, scanUiSources, type ScanResult } from './source-scan';
import { translate, translateEnum, translatePlural } from './translate';

const scan = scanUiSources(resolve(__dirname, '../..'));
const placeholders = (text: string) => [...text.matchAll(/\{\w+\}/g)].map((m) => m[0]).sort();

const emptyResult = (): ScanResult => ({ keys: new Map(), pluralKeys: new Map(), hardCoded: [] });

describe('UI dictionaries', () => {
  it('scans the real UI sources', () => {
    expect(scan.keys.size).toBeGreaterThan(300);
    expect([...scan.pluralKeys.keys()].sort()).toEqual(Object.keys(plurals).sort());
  });

  it('has every key used in the sources', () => {
    const missing = [...scan.keys].filter(([key]) => !Object.hasOwn(messages, key));
    expect(missing).toEqual([]);
  });

  it('has Russian and Chinese text with the same placeholders for every key', () => {
    const broken = Object.entries(messages).filter(([key, translations]) =>
      translations.length !== 2 ||
      translations.some((text) => !text.trim() ||
        JSON.stringify(placeholders(text)) !== JSON.stringify(placeholders(key))),
    );
    expect(broken.map(([key]) => key)).toEqual([]);
    // Chinese text must actually be Chinese, apart from the product title.
    expect(Object.values(messages).filter(([, zh]) => !/\p{Script=Han}/u.test(zh))).toEqual([]);
    expect(Object.values(messages).filter(([ru]) => !/\p{Script=Cyrillic}/u.test(ru))).toEqual([]);
  });

  it('has every plural form each language can select', () => {
    for (const [key, forms] of Object.entries(plurals)) {
      for (const locale of LOCALES) {
        const rules = new Intl.PluralRules(DATE_LOCALE[locale]);
        for (const category of rules.resolvedOptions().pluralCategories) {
          // `other` in Russian covers fractions; counts here are whole numbers.
          expect(
            (forms[locale] as Record<string, string>)[category] ??
              (forms[locale] as Record<string, string>).other,
            `${key} ${locale} ${category}`,
          ).toBeTruthy();
        }
      }
    }
  });

  it('keeps no hard-coded text in the UI sources', () => {
    expect(scan.hardCoded).toEqual([]);
  });

  it('reports hard-coded text and unknown keys (negative control)', () => {
    const result = emptyResult();
    scanSource(
      'probe.tsx',
      `export const P = ({ on }: { on: boolean }) => (
        <div title="Hover text">Plain text{on ? 'Branch one' : t('No such key')}
          <input placeholder={\`Search \${on}\`} /><T k="Also unknown" /></div>);`,
      result,
    );
    expect(result.hardCoded.map((entry) => entry.slice(entry.indexOf(' ') + 1))).toEqual([
      '"Hover text"', '"Plain text"', '"Branch one"', '"Search"',
    ]);
    expect([...result.keys.keys()]).toEqual(['No such key', 'Also unknown']);
    expect(Object.hasOwn(messages, 'No such key')).toBe(false);
  });

  it('translates statuses, placeholders, enums and counts', () => {
    for (const status of TASK_STATUSES) {
      expect(Object.hasOwn(messages, TASK_STATUS_LABELS[status])).toBe(true);
    }
    expect(translate('en', 'Due {date}', { date: 'X' })).toBe('Due X');
    expect(translate('ru', 'Due {date}', { date: 'X' })).toBe('Срок: X');
    expect(translate('zh', 'Task ID copied.')).toBe('任务 ID 已复制。');
    expect(translateEnum('ru', 'owner')).toBe('владелец');
    expect(translateEnum('ru', 'something-new')).toBe('something-new');
    expect(translateEnum('ru', undefined)).toBe('');
    expect([1, 2, 5, 21].map((n) => translatePlural('ru', 'task', n))).toEqual([
      '1 задача', '2 задачи', '5 задач', '21 задача',
    ]);
    expect([1, 2].map((n) => translatePlural('en', 'member', n))).toEqual(['1 member', '2 members']);
  });
});
