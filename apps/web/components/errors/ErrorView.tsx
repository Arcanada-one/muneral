'use client';

import { PreferenceToggles } from '@/components/preferences/PreferenceSwitchers';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n/useI18n';

/** What a failed render shows. The error itself is never printed: it may carry data. */
export function ErrorView({ reset }: { reset: () => void }) {
  const { t } = useI18n();

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <PreferenceToggles className="absolute right-4 top-4" />
      <h1 role="alert" className="text-2xl font-bold">
        {t('Something went wrong')}
      </h1>
      <Button type="button" onClick={reset}>
        {t('Try again')}
      </Button>
      {/* A document load, not a client navigation: the client app (and its router) is what failed. */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a href="/workspaces" className="text-sm font-medium underline underline-offset-4">
        {t('Back to workspaces')}
      </a>
    </main>
  );
}
