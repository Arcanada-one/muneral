import { TASK_STATUSES, type TaskStatus } from '@muneral/types';

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  review: 'Review',
  blocked: 'Blocked',
  done: 'Done',
  cancelled: 'Cancelled',
  archived: 'Archived',
};

export function getTaskStatusLabel(status: string): string | undefined {
  const knownStatus = TASK_STATUSES.find((candidate) => candidate === status);
  return knownStatus ? TASK_STATUS_LABELS[knownStatus] : undefined;
}
