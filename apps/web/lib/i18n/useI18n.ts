'use client';

import { useMemo } from 'react';
import { usePreferences } from '@/components/preferences/PreferencesProvider';
import { DATE_LOCALE } from '@/lib/preferences/preferences';
import type { MessageKey, PluralKey } from './messages';
import { translate, translateEnum, translatePlural, type Values } from './translate';

export function useI18n() {
  const { locale } = usePreferences();
  return useMemo(
    () => ({
      locale,
      dateLocale: DATE_LOCALE[locale],
      t: (key: MessageKey, values?: Values) => translate(locale, key, values),
      /** Server-provided enum values; unknown ones are shown unchanged. */
      te: (value: string | null | undefined) => translateEnum(locale, value),
      tp: (key: PluralKey, count: number, values?: Values) =>
        translatePlural(locale, key, count, values),
    }),
    [locale],
  );
}
