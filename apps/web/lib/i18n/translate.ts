import { DATE_LOCALE, type Locale } from '@/lib/preferences/preferences';
import { messages, plurals, type MessageKey, type PluralKey } from './messages';

export type Values = Record<string, string | number>;

function fill(template: string, values?: Values): string {
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match,
  );
}

const own = (table: object, key: string) => Object.prototype.hasOwnProperty.call(table, key);

function isMessageKey(value: string): value is MessageKey {
  return own(messages, value);
}

/**
 * The English text is the message key; `messages` holds the other languages. A key without an entry
 * falls back to the English text, which is the key itself, in every language: a missing
 * translation must not crash a page.
 */
export function translate(locale: Locale, key: MessageKey, values?: Values): string {
  const template =
    locale !== 'en' && isMessageKey(key) ? messages[key][locale === 'ru' ? 0 : 1] : key;
  return fill(String(template), values);
}

export function translateEnum(locale: Locale, value: string | null | undefined): string {
  if (!value) return '';
  return isMessageKey(value) ? translate(locale, value) : value;
}

export function translatePlural(
  locale: Locale,
  key: PluralKey,
  count: number,
  values?: Values,
): string {
  if (!own(plurals, key)) return String(key);
  const forms: Partial<Record<Intl.LDMLPluralRule, string>> = plurals[key][locale];
  const category = new Intl.PluralRules(DATE_LOCALE[locale]).select(count);
  const template = forms[category] ?? forms.other ?? '';
  return fill(template, { count, ...values });
}
