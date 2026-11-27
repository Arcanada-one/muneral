'use client';

import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { SessionProvider } from 'next-auth/react';
import { TaskDetailSessionProvider } from '@/lib/api/task-detail-session';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    // Re-reads the session before a 5-minute access token lapses, so long-lived users of the token
    // (the kanban socket) get the one the server refreshed.
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
