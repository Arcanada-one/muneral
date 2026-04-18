'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
// arrayMove used when reordering within same column (future enhancement)
import { useSession } from 'next-auth/react';
import { KanbanColumn } from './KanbanColumn';
import { KanbanCard } from './KanbanCard';
import { useTasks, useUpdateTaskStatus, type Task } from '@/lib/api/tasks';
import { createKanbanWsClient, type KanbanWsClient } from '@/lib/ws/kanban';
import type { TaskStatus } from '@muneral/types';

interface KanbanBoardProps {
  projectId: string;
  wsSlug: string;
  projSlug: string;
}

const KANBAN_STATUSES: TaskStatus[] = [
  'todo',
  'in_progress',
  'review',
  'done',
  'cancelled',
];

export function KanbanBoard({ projectId, wsSlug, projSlug }: KanbanBoardProps) {
  const { data: session } = useSession();
  const [pollingEnabled, setPollingEnabled] = useState(false);
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const wsClientRef = useRef<KanbanWsClient | null>(null);

  const { data: tasksResult, refetch } = useTasks(projectId, {});
  const updateStatus = useUpdateTaskStatus();

  const tasks = useMemo(() => tasksResult?.data ?? [], [tasksResult]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
  );

  // WebSocket setup with polling fallback
  useEffect(() => {
    const accessToken = (session as Record<string, unknown> | null)?.accessToken;
    if (typeof accessToken !== 'string' || !projectId) return;

    const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3500';
    const client = createKanbanWsClient({
      apiUrl,
      workspaceId: wsSlug,
      accessToken,
      onEvent: (event) => {
        if (event.type === 'task:moved' || event.type === 'task:updated' || event.type === 'task:created') {
          refetch();
        }
      },
      onFallbackToPolling: () => setPollingEnabled(true),
      onPollingCancelled: () => setPollingEnabled(false),
    });

    client.connect();
    wsClientRef.current = client;

    return () => {
      client.disconnect();
      wsClientRef.current = null;
    };
  }, [session, projectId, wsSlug, refetch]);

  // Polling fallback when WS is disconnected
  useEffect(() => {
    if (!pollingEnabled) return;
    const timer = setInterval(() => {
      refetch();
    }, 10_000);
    return () => clearInterval(timer);
  }, [pollingEnabled, refetch]);

  const getTasksByStatus = useCallback(
    (status: TaskStatus) => tasks.filter((t) => t.status === status),
    [tasks],
  );

  const handleDragStart = useCallback(
    (event: { active: { id: string | number } }) => {
      const task = tasks.find((t) => t.id === String(event.active.id));
      setActiveTask(task ?? null);
    },
    [tasks],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveTask(null);
      const { active, over } = event;
      if (!over) return;

      const taskId = String(active.id);
      const overId = String(over.id);

      const task = tasks.find((t) => t.id === taskId);
      if (!task) return;

      // Dropped on a column (status id)
      if (KANBAN_STATUSES.includes(overId as TaskStatus)) {
        const newStatus = overId as TaskStatus;
        if (task.status !== newStatus) {
          updateStatus.mutate({ taskId, status: newStatus });
        }
        return;
      }

      // Dropped on another card — move within or across columns
      const overTask = tasks.find((t) => t.id === overId);
      if (overTask && overTask.status !== task.status) {
        updateStatus.mutate({ taskId, status: overTask.status });
      }
    },
    [tasks, updateStatus],
  );

  return (
    <div className="relative">
      {pollingEnabled && (
        <div className="mb-2 flex items-center gap-2 rounded-md bg-amber-50 px-3 py-1.5 text-xs text-amber-700">
          <span className="h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
          Live updates paused — polling every 10s
        </div>
      )}

      <DndContext
        sensors={sensors}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div className="flex gap-4 overflow-x-auto pb-4">
          {KANBAN_STATUSES.map((status) => (
            <KanbanColumn
              key={status}
              status={status}
              tasks={getTasksByStatus(status)}
              wsSlug={wsSlug}
              projSlug={projSlug}
            />
          ))}
        </div>

        <DragOverlay>
          {activeTask ? (
            <div className="rotate-2 opacity-90">
              <KanbanCard task={activeTask} wsSlug={wsSlug} projSlug={projSlug} />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
