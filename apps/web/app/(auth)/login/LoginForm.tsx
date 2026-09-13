'use client';

import { signIn } from 'next-auth/react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';

// lucide-react 1.x removed its brand icons — `Github` is gone from the package,
// not renamed (measured: the 1.39 typings export GitBranch, GitFork, GitMerge and
// no brand mark at all). A generic git glyph would misidentify the provider on a
// sign-in button, so the mark itself is inlined here: it is GitHub's own official
// logo path, the same one lucide shipped.
function GithubMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.73.5.5 5.73.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.88-1.54-3.88-1.54-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.56-.29-5.25-1.28-5.25-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.43-2.7 5.41-5.27 5.69.41.36.78 1.06.78 2.14 0 1.55-.01 2.8-.01 3.18 0 .31.21.68.8.56C20.71 21.39 24 17.08 24 12 24 5.73 18.77.5 12 .5Z" />
    </svg>
  );
}

export function LoginForm() {
  const handleGitHub = () => {
    signIn('github', { callbackUrl: '/workspaces' });
  };

  return (
    <div className="space-y-4">
      <Button onClick={handleGitHub} className="w-full" variant="outline">
        <GithubMark className="mr-2 h-4 w-4" />
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
