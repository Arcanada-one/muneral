'use client';

import { useI18n } from '@/lib/i18n/useI18n';
import type { MessageKey } from '@/lib/i18n/messages';

/** Translated text for server components, updating as soon as the language changes. */
export function T({ k }: { k: MessageKey }) {
  const { t } = useI18n();
  return <>{t(k)}</>;
}
