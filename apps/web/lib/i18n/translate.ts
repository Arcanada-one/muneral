import { DATE_LOCALE, type Locale } from '@/lib/preferences/preferences';
import { messages, plurals, type MessageKey, type PluralKey } from './messages';

export type Values = Record<string, string | number>;

function fill(template: string, values?: Values): string {
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match,
  );
}

/** The English text is the message key; `messages` holds the other languages. */
export function translate(locale: Locale, key: MessageKey, values?: Values): string {
  const template = locale === 'en' ? key : messages[key][locale === 'ru' ? 0 : 1];
  return fill(template, values);
}

function isMessageKey(value: string): value is MessageKey {
  return Object.prototype.hasOwnProperty.call(messages, value);
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
  const forms: Partial<Record<Intl.LDMLPluralRule, string>> = plurals[key][locale];
  const category = new Intl.PluralRules(DATE_LOCALE[locale]).select(count);
  const template = forms[category] ?? forms.other ?? '';
  return fill(template, { count, ...values });
}
