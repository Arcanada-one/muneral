'use client';

import { useEffect, useRef, useState } from 'react';

/** Module-private clipboard control for an already-accepted repository URL. */
export function CopyRepositoryUrl({ repoUrl }: { repoUrl: string }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [isCopying, setIsCopying] = useState(false);
  const pendingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const copyRepositoryUrl = async () => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setCopyState('idle');
    setIsCopying(true);

    try {
      const writeText = navigator.clipboard?.writeText;
      if (typeof writeText !== 'function') {
        throw new Error('clipboard unavailable');
      }
      await writeText.call(navigator.clipboard, repoUrl);
      if (mountedRef.current) setCopyState('copied');
    } catch {
      if (mountedRef.current) setCopyState('failed');
    } finally {
      if (mountedRef.current) {
        pendingRef.current = false;
        setIsCopying(false);
      }
    }
  };

  return (
    <>
      <button
        type="button"
        className="inline-flex min-h-11 items-center text-sm font-medium underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        onClick={() => {
          void copyRepositoryUrl();
        }}
        disabled={isCopying}
      >
        Copy repository URL
      </button>
      {copyState === 'copied' && (
        <span role="status" className="basis-full text-xs text-green-700">
          Repository URL copied.
        </span>
      )}
      {copyState === 'failed' && (
        <span role="alert" className="basis-full text-xs text-destructive">
          Could not copy repository URL. Try copying it manually.
        </span>
      )}
    </>
  );
}
