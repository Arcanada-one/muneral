'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { useDetailSession } from '@/lib/api/task-detail-session';
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
  const committed = useRef(selection);
  committed.current = selection;
  const [controller] = useState(() => session.controller({
    current: () => committed.current,
    open: tuple => router.push(`/workspaces/${encodeURIComponent(tuple.workspaceSlug)}/projects/${encodeURIComponent(tuple.projectSlug)}/tasks/${encodeURIComponent(tuple.taskId)}`),
  }));
  const snapshot = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  useEffect(() => {
    if (session.active) controller.openTask({workspaceSlug: wsSlug, projectSlug: projSlug, taskId}, false);
    else controller.leave();
    return () => controller.leave();
  }, [controller, session.active, wsSlug, projSlug, taskId]);
  const mounts = useRef(0);
  useEffect(() => {
    const mount = ++mounts.current;
    // React's development effect rehearsal must not permanently dispose its reused controller.
    return () => { queueMicrotask(() => { if (mounts.current === mount) controller.dispose(); }); };
  }, [controller]);
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
