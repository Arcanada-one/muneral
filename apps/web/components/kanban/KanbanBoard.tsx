'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import { Button } from '@/components/ui/button';
import { taskDetailHref } from '@/lib/task-detail-href';
import { Copy } from 'lucide-react';
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
  const getTasksByStatus = useCallback(
    (status: TaskStatus) => tasks.filter((t) => t.status === status),
    [tasks],
  );
  const visibleTasks = useMemo(
    () => KANBAN_STATUSES.flatMap((status) => getTasksByStatus(status)),
    [getTasksByStatus],
  );
  const viewKey = JSON.stringify([
    projectId,
    wsSlug,
    projSlug,
    visibleTasks.map((task) => task.id),
  ]);
  const viewToken = useMemo(() => ({ key: viewKey }), [viewKey]);
  const currentViewTokenRef = useRef<object | null>(viewToken);
  const pendingCopyRef = useRef<{ viewToken: object } | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<{
    viewToken: object;
    status: 'pending' | 'success' | 'failed';
  } | null>(null);

  useLayoutEffect(() => {
    currentViewTokenRef.current = viewToken;
  }, [viewToken]);

  useEffect(() => {
    currentViewTokenRef.current = viewToken;
    return () => {
      if (currentViewTokenRef.current === viewToken) {
        currentViewTokenRef.current = null;
      }
    };
  }, [viewToken]);

  const copyVisibleTaskLinks = useCallback(async () => {
    if (pendingCopyRef.current?.viewToken === viewToken || visibleTasks.length === 0) return;

    const request = { viewToken };
    pendingCopyRef.current = request;
    setCopyFeedback({ viewToken, status: 'pending' });

    try {
      const seen = new Set<string>();
      const urls = visibleTasks.flatMap((task) => {
        if (seen.has(task.id)) return [];
        seen.add(task.id);
        return [new URL(taskDetailHref(wsSlug, projSlug, task.id), window.location.origin).href];
      });
      const clipboard = navigator.clipboard;
      if (!clipboard || typeof clipboard.writeText !== 'function') {
        throw new Error('Clipboard is unavailable');
      }
      await clipboard.writeText(urls.join('\n'));
      if (currentViewTokenRef.current === viewToken && pendingCopyRef.current === request) {
        setCopyFeedback({ viewToken, status: 'success' });
      }
    } catch {
      if (currentViewTokenRef.current === viewToken && pendingCopyRef.current === request) {
        setCopyFeedback({ viewToken, status: 'failed' });
      }
    } finally {
      if (pendingCopyRef.current === request) {
        pendingCopyRef.current = null;
      }
    }
  }, [projSlug, visibleTasks, viewToken, wsSlug]);

  // Status-change error feedback is scoped to the current project visit: a new scope object
  // is created per projectId; a layout effect advances the current-scope ref on change, so an
  // error recorded under an earlier scope is no longer shown (cleared by derivation, which
  // avoids setState inside an effect); the per-call error handler re-checks the same scope
  // object so late errors after a project change are suppressed.
  const statusScope = useMemo(() => ({ projectId }), [projectId]);
  const currentStatusScopeRef = useRef<object>(statusScope);
  const [statusError, setStatusError] = useState<{ scope: object } | null>(null);

  useLayoutEffect(() => {
    currentStatusScopeRef.current = statusScope;
  }, [statusScope]);

  const changeStatus = useCallback(
    (taskId: string, status: TaskStatus) => {
      const scope = statusScope;
      setStatusError(null);
      updateStatus.mutate(
        { taskId, status },
        {
          onError: () => {
            if (currentStatusScopeRef.current === scope) {
              setStatusError({ scope });
            }
          },
        },
      );
    },
    [statusScope, updateStatus],
  );
  const currentStatusError = statusError?.scope === statusScope ? statusError : null;

  const currentCopyFeedback = copyFeedback?.viewToken === viewToken ? copyFeedback : null;
  const copyIsPending = currentCopyFeedback?.status === 'pending';

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
          changeStatus(taskId, newStatus);
        }
        return;
      }

      // Dropped on another card — move within or across columns
      const overTask = tasks.find((t) => t.id === overId);
      if (overTask && overTask.status !== task.status) {
        changeStatus(taskId, overTask.status);
      }
    },
    [tasks, changeStatus],
  );

  return (
    <div className="relative">
      {pollingEnabled && (
        <div className="mb-2 flex items-center gap-2 rounded-md bg-amber-50 px-3 py-1.5 text-xs text-amber-700">
          <span className="h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
          Live updates paused — polling every 10s
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-3" role="group" aria-label="Task list actions">
        <Button
          type="button"
          onClick={copyVisibleTaskLinks}
          disabled={visibleTasks.length === 0 || copyIsPending}
          aria-describedby="copy-visible-task-links-help"
        >
          <Copy className="h-4 w-4" aria-hidden="true" />
          {copyIsPending ? 'Copying task links…' : 'Copy visible task links'}
        </Button>
        <p id="copy-visible-task-links-help" className="text-sm text-muted-foreground">
          {visibleTasks.length === 0
            ? 'There are no visible task cards to copy.'
            : 'Copies links for the task cards currently shown on this board.'}
        </p>
        {currentCopyFeedback?.status === 'pending' && (
          <p role="status" className="basis-full text-sm text-muted-foreground">
            Copying task links…
          </p>
        )}
        {currentCopyFeedback?.status === 'success' && (
          <p role="status" className="basis-full text-sm text-green-700">
            Task links copied.
          </p>
        )}
        {currentCopyFeedback?.status === 'failed' && (
          <p role="alert" className="basis-full text-sm text-destructive">
            Could not copy task links. Try again or copy a task link manually.
          </p>
        )}
      </div>

      {currentStatusError && (
        <p role="alert" className="mb-3 text-sm text-destructive">
          Could not change the task status. Try again.
        </p>
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
