'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { useTask } from '@/lib/api/tasks';
import { TaskDetail } from '@/components/task/TaskDetail';
import { Button } from '@/components/ui/button';

export default function TaskPage() {
  const { wsSlug, projSlug, taskId } = useParams<{
    wsSlug: string;
    projSlug: string;
    taskId: string;
  }>();

  const { data: task, isLoading, error } = useTask(taskId);

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <p className="text-muted-foreground">Loading task...</p>
      </div>
    );
  }

  if (error || !task) {
    return (
      <div className="rounded-lg border p-8 text-center">
        <p className="text-muted-foreground">Task not found</p>
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
