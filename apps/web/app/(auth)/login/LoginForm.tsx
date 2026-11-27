'use client';

import { signIn } from 'next-auth/react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n/useI18n';

/** The only way in is Auth Arcana; which identity to use is chosen on its page. */
export function LoginForm({ enabled, failed }: { enabled: boolean; failed: boolean }) {
  const { t, locale } = useI18n();

  return (
    <div className="space-y-4">
      {failed && (
        <p role="alert" className="text-center text-sm text-destructive">
          {t('Sign-in did not complete. Try again.')}
        </p>
      )}
      {enabled ? (
        <Button
          onClick={() => {
            void signIn('arcanada', { callbackUrl: '/workspaces' }, { ui_locales: locale });
          }}
          className="w-full"
          variant="outline"
        >
          {t('Sign in with Arcana')}
        </Button>
      ) : (
        <p role="status" className="text-center text-sm text-muted-foreground">
          {t('Sign-in is not available yet.')}
        </p>
      )}

      <p className="text-center text-xs text-muted-foreground">
        {t('By signing in, you agree to the Terms of Service')}
      </p>
    </div>
  );
}
