import { TASK_STATUSES, type TaskStatus } from '@muneral/types';
import type { MessageKey } from './i18n/messages';

export const TASK_STATUS_LABELS = {
  todo: 'To Do',
  in_progress: 'In Progress',
  review: 'Review',
  blocked: 'Blocked',
  done: 'Done',
  cancelled: 'Cancelled',
  archived: 'Archived',
} as const satisfies Record<TaskStatus, MessageKey>;

export function getTaskStatusLabel(status: string) {
  const knownStatus = TASK_STATUSES.find((candidate) => candidate === status);
  return knownStatus ? TASK_STATUS_LABELS[knownStatus] : undefined;
}
