'use client';

import { signIn } from 'next-auth/react';
import { Github } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';

export function LoginForm() {
  const handleGitHub = () => {
    signIn('github', { callbackUrl: '/workspaces' });
  };

  return (
    <div className="space-y-4">
      <Button onClick={handleGitHub} className="w-full" variant="outline">
        <Github className="mr-2 h-4 w-4" />
        Continue with GitHub
      </Button>

      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <Separator className="flex-1" />
        or
        <Separator className="flex-1" />
      </div>

      {/* Telegram Login Widget placeholder */}
      <div
        id="telegram-login-widget"
        className="flex justify-center"
        data-telegram-login={process.env.NEXT_PUBLIC_TELEGRAM_BOT_NAME ?? 'MuneralBot'}
        data-size="large"
        data-auth-url={`${process.env.NEXT_PUBLIC_APP_URL ?? ''}/api/auth/telegram-callback`}
        data-request-access="write"
      />

      <p className="text-center text-xs text-muted-foreground">
        By signing in, you agree to the Terms of Service
      </p>
    </div>
  );
}
