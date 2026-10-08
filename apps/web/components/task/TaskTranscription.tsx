'use client';

import { transcriptionLink } from '@/lib/api/read-contract';

export function TaskTranscription({link}: {link?: {jobId: string; producerRoute: string}}) {
  if (link === undefined) return null;
  const result = transcriptionLink.safeParse(link);
  if (!result.success) return <div role="alert">Transcription link is unavailable.</div>;
  return <section aria-label="Transcription" className="rounded-lg border p-4">
    <h3 className="mb-2 text-sm font-medium">Transcription</h3>
    <a href={result.data.producerRoute} target="_blank" rel="noopener noreferrer" className="break-all text-sm underline">Open transcription</a>
    <p className="mt-2 text-xs text-muted-foreground">Producer authentication required. Production R2 not measured.</p>
  </section>;
}
