'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { TaskDetailController, type DetailNavigationPort } from './task-detail-controller';
import { taskDetailReadPort } from './task-detail-read';

interface DetailSession {
  active: boolean;
  controller(navigation: DetailNavigationPort): TaskDetailController;
}
const Context = createContext<DetailSession | null>(null);
export function useDetailSession(): DetailSession {
  const value = useContext(Context);
  if (!value) throw new Error('Task detail requires the session Query provider');
  return value;
}
function SessionQueries({active, children}: {active: boolean; children: React.ReactNode}) {
  const [query] = useState(() => new QueryClient({defaultOptions: {queries: {staleTime: 60_000, retry: 1}}}));
  const [session] = useState<DetailSession>(() => ({active,
    controller: navigation => {
      return new TaskDetailController(taskDetailReadPort(query), navigation);
    },
  }));
  useEffect(() => () => {
    void query.cancelQueries(); query.clear();
  }, [query]);
  return <Context.Provider value={session}><QueryClientProvider client={query}>{children}</QueryClientProvider></Context.Provider>;
}
/** An opaque lifetime key changes on logout/loading/token replacement. Credentials never enter query keys or snapshots. */
export function TaskDetailSessionProvider({children}: {children: React.ReactNode}) {
  const {data, status} = useSession();
  const token = (data as unknown as {accessToken?: unknown} | null)?.accessToken;
  const active = status === 'authenticated' && typeof token === 'string' && token.length > 0;
  const [previous, setPrevious] = useState({token, status, generation: 0});
  if (previous.token !== token || previous.status !== status) {
    // Adjust this component's own state and suppress children until the new lifetime commits.
    setPrevious({token, status, generation: previous.generation + 1});
    return null;
  }
  return <SessionQueries key={previous.generation} active={active}>{children}</SessionQueries>;
}
