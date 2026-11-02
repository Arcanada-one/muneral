import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuditLog } from '../../components/task/AuditLog';
import { getFixtureStats, TASK_IDS } from './synthetic-api-client.mjs';

window.__activityCountFixtureStats = getFixtureStats;

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  },
});

function FixtureApp() {
  const [taskId, setTaskId] = useState(TASK_IDS.populated);
  const nextTaskId = taskId === TASK_IDS.populated ? TASK_IDS.empty : TASK_IDS.populated;
  const nextTaskLabel = taskId === TASK_IDS.populated ? 'empty' : 'populated';

  return (
    <>
      <button
        type="button"
        aria-label={`Switch to ${nextTaskLabel} task`}
        onClick={() => setTaskId(nextTaskId)}
      >
        Switch fixture task
      </button>
      <AuditLog taskId={taskId} />
    </>
  );
}

createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={queryClient}>
    <FixtureApp />
  </QueryClientProvider>,
);
