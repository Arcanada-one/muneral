'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { useDetailSession } from '@/lib/api/task-detail-session';
import type { TaskSelection } from '@/lib/api/task-detail-controller';
import { TaskDetail } from '@/components/task/TaskDetail';
import { Button } from '@/components/ui/button';

export default function TaskPage() {
  const { wsSlug, projSlug, taskId } = useParams<{
    wsSlug: string;
    projSlug: string;
    taskId: string;
  }>();
  const router = useRouter();
  const session = useDetailSession();
  const selection = {workspaceSlug: wsSlug, projectSlug: projSlug, taskId};
  const [navigation] = useState(() => {
    let location: TaskSelection | null = null;
    return {
      current: () => location,
      commit: (tuple: TaskSelection) => { location = tuple; },
      open: (tuple: TaskSelection) => router.push(`/workspaces/${encodeURIComponent(tuple.workspaceSlug)}/projects/${encodeURIComponent(tuple.projectSlug)}/tasks/${encodeURIComponent(tuple.taskId)}`),
    };
  });
  const [controller] = useState(() => session.controller(navigation));
  useLayoutEffect(() => {
    navigation.commit({workspaceSlug: wsSlug, projectSlug: projSlug, taskId});
  }, [navigation, wsSlug, projSlug, taskId]);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  useEffect(() => {
    if (session.active) controller.openTask({workspaceSlug: wsSlug, projectSlug: projSlug, taskId}, false);
    else controller.leave();
    return () => controller.leave();
  }, [controller, session.active, wsSlug, projSlug, taskId]);
  const [lifetime] = useState(() => {
    let mounts = 0;
    return {start: () => ++mounts, current: () => mounts};
  });
  useEffect(() => {
    const mount = lifetime.start();
    // React's development effect rehearsal must not permanently dispose its reused controller.
    return () => { queueMicrotask(() => { if (lifetime.current() === mount) controller.dispose(); }); };
  }, [controller, lifetime]);
  const task = session.active ? controller.taskFor(selection) : undefined;

  if (session.active && ['idle', 'loading'].includes(snapshot.outcome)) {
    return (
      <div className="flex h-64 items-center justify-center">
        <p className="text-muted-foreground">Loading task...</p>
      </div>
    );
  }

  if (!task) {
    return (
      <div className="rounded-lg border p-8 text-center">
        <p role="alert" className="text-muted-foreground">{
          !session.active || snapshot.outcome === 'denied' ? 'Task access denied' :
            snapshot.outcome === 'missing' ? 'Task not found' : 'Task is unavailable'
        }</p>
        <Button variant="ghost" className="mt-4" asChild>
          <Link href={`/workspaces/${wsSlug}/projects/${projSlug}`}>
            Back to project
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div>
        <Button variant="ghost" size="sm" asChild>
          <Link
            href={`/workspaces/${wsSlug}/projects/${projSlug}`}
            className="flex items-center gap-1 text-muted-foreground"
          >
            <ChevronLeft className="h-4 w-4" />
            Back to board
          </Link>
        </Button>
      </div>

      <TaskDetail task={task} />
    </div>
  );
}
