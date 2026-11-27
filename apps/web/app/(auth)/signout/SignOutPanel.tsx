'use client';

import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n/useI18n';

export function SignOutPanel() {
  const { t } = useI18n();

  return (
    <>
      <h1 className="text-2xl font-bold">{t('Sign out of Muneral?')}</h1>
      {/* The server drops its tokens and ends the Auth Arcana session too. */}
      <form method="post" action="/api/logout">
        <Button type="submit">{t('Sign out')}</Button>
      </form>
      <Link href="/workspaces" className="text-sm font-medium underline underline-offset-4">
        {t('Back to workspaces')}
      </Link>
    </>
  );
}
