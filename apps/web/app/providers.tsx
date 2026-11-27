'use client';

import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { SessionProvider } from 'next-auth/react';
import { TaskDetailSessionProvider } from '@/lib/api/task-detail-session';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    // Re-reads the session every 240 s, counted from page load and not from the token's expiry. The
    // server renews a token only in its last 60 s, so a page loaded when the token is 60 to 240 s
    // old can hold an expired one for up to 180 s before the first poll. An API call answered 401
    // asks the server again; what a long-lived user of the token (the kanban socket) does in that
    // window is not measured.
    <SessionProvider refetchInterval={240}>
      <TaskDetailSessionProvider>
        {children}
        {process.env.NODE_ENV === 'development' && (
          <ReactQueryDevtools initialIsOpen={false} />
        )}
      </TaskDetailSessionProvider>
    </SessionProvider>
  );
}
