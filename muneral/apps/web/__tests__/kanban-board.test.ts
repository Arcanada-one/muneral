import { describe, it, expect, vi } from 'vitest';
import type { DragEndEvent } from '@dnd-kit/core';
import type { Task } from '@/lib/api/tasks';
import type { TaskStatus } from '@muneral/types';

/**
 * Pure logic tests for Kanban drag-end handler.
 * These test the decision logic without React/DOM.
 */

const KANBAN_STATUSES: TaskStatus[] = [
  'todo',
  'in_progress',
  'review',
  'done',
  'cancelled',
];

function buildTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Test task',
    status: 'todo',
    priority: 'medium',
    projectId: 'proj-1',
    tags: [],
    actorType: 'human',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Extracted handler logic for unit testing.
 */
function handleDragEndLogic(
  tasks: Task[],
  activeId: string,
  overId: string,
  updateStatus: (args: { taskId: string; status: TaskStatus }) => void,
): void {
  const task = tasks.find((t) => t.id === activeId);
  if (!task) return;

  if (KANBAN_STATUSES.includes(overId as TaskStatus)) {
    const newStatus = overId as TaskStatus;
    if (task.status !== newStatus) {
      updateStatus({ taskId: activeId, status: newStatus });
    }
    return;
  }

  const overTask = tasks.find((t) => t.id === overId);
  if (overTask && overTask.status !== task.status) {
    updateStatus({ taskId: activeId, status: overTask.status });
  }
}

describe('Kanban drag-end handler logic', () => {
  it('does nothing when active task not found', () => {
    const updateStatus = vi.fn();
    const tasks = [buildTask({ id: 'task-1' })];
    handleDragEndLogic(tasks, 'unknown-id', 'in_progress', updateStatus);
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it('does nothing when dropped without over target (overId empty)', () => {
    const updateStatus = vi.fn();
    const tasks = [buildTask({ id: 'task-1', status: 'todo' })];
    // Simulate null/undefined over — overId won't match anything
    handleDragEndLogic(tasks, 'task-1', '', updateStatus);
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it('updates status when dropped on a different column', () => {
    const updateStatus = vi.fn();
    const tasks = [buildTask({ id: 'task-1', status: 'todo' })];
    handleDragEndLogic(tasks, 'task-1', 'in_progress', updateStatus);
    expect(updateStatus).toHaveBeenCalledWith({
      taskId: 'task-1',
      status: 'in_progress',
    });
  });

  it('does not update status when dropped on same column', () => {
    const updateStatus = vi.fn();
    const tasks = [buildTask({ id: 'task-1', status: 'todo' })];
    handleDragEndLogic(tasks, 'task-1', 'todo', updateStatus);
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it('updates status when dropped on a card in a different column', () => {
    const updateStatus = vi.fn();
    const tasks = [
      buildTask({ id: 'task-1', status: 'todo' }),
      buildTask({ id: 'task-2', status: 'in_progress' }),
    ];
    handleDragEndLogic(tasks, 'task-1', 'task-2', updateStatus);
    expect(updateStatus).toHaveBeenCalledWith({
      taskId: 'task-1',
      status: 'in_progress',
    });
  });

  it('does not update status when dropped on a card in the same column', () => {
    const updateStatus = vi.fn();
    const tasks = [
      buildTask({ id: 'task-1', status: 'todo' }),
      buildTask({ id: 'task-2', status: 'todo' }),
    ];
    handleDragEndLogic(tasks, 'task-1', 'task-2', updateStatus);
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it('handles all valid Kanban status targets', () => {
    const statuses: TaskStatus[] = ['todo', 'in_progress', 'review', 'done', 'cancelled'];
    statuses.forEach((targetStatus) => {
      const updateStatus = vi.fn();
      const tasks = [buildTask({ id: 'task-1', status: 'todo' })];
      if (targetStatus !== 'todo') {
        handleDragEndLogic(tasks, 'task-1', targetStatus, updateStatus);
        expect(updateStatus).toHaveBeenCalledWith({
          taskId: 'task-1',
          status: targetStatus,
        });
      }
    });
  });

  it('does not call updateStatus for non-status, non-task overId', () => {
    const updateStatus = vi.fn();
    const tasks = [buildTask({ id: 'task-1', status: 'todo' })];
    handleDragEndLogic(tasks, 'task-1', 'some-random-id', updateStatus);
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it('handles multiple tasks in board correctly', () => {
    const updateStatus = vi.fn();
    const tasks = [
      buildTask({ id: 'task-1', status: 'todo' }),
      buildTask({ id: 'task-2', status: 'todo' }),
      buildTask({ id: 'task-3', status: 'review' }),
    ];
    handleDragEndLogic(tasks, 'task-2', 'review', updateStatus);
    expect(updateStatus).toHaveBeenCalledWith({
      taskId: 'task-2',
      status: 'review',
    });
  });
});
