'use client';

import Link from 'next/link';
import { signOut } from 'next-auth/react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n/useI18n';

export function SignOutPanel() {
  const { t } = useI18n();

  return (
    <>
      <h1 className="text-2xl font-bold">{t('Sign out of Muneral?')}</h1>
      <Button type="button" onClick={() => void signOut({ callbackUrl: '/login' })}>
        {t('Sign out')}
      </Button>
      <Link href="/workspaces" className="text-sm font-medium underline underline-offset-4">
        {t('Back to workspaces')}
      </Link>
    </>
  );
}
