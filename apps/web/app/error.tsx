'use client';

import { ErrorView } from '@/components/errors/ErrorView';

/** Rendered inside the root layout, which already set the language and theme from the cookies. */
export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return <ErrorView reset={reset} />;
}
