'use client';

import { useEffect } from 'react';
import { useParams } from 'next/navigation';
import { useWorkspaceStore } from '@/store/workspace';

export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const { wsSlug } = useParams<{ wsSlug: string }>();
  const { setCurrentSlug } = useWorkspaceStore();

  useEffect(() => {
    if (wsSlug) {
      setCurrentSlug(wsSlug);
    }
  }, [wsSlug, setCurrentSlug]);

  return <>{children}</>;
}
