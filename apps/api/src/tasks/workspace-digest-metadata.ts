import { isUUID, isString } from 'class-validator';
import { TASK_STATUSES } from '@muneral/types';
import type { TaskStatus } from '@muneral/types';
type DigestMetadata = { id: string; projectId: string; status: TaskStatus;
  priority: 'critical' | 'high' | 'medium' | 'low'; createdAt: Date; updatedAt: Date };
const DIGEST_METADATA_KEYS = ['id', 'projectId', 'status', 'priority', 'createdAt', 'updatedAt'];
export function isDigestMetadata(value: unknown): value is DigestMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 6 || !DIGEST_METADATA_KEYS.every(k => Object.hasOwn(row, k))) return false;
  return typeof row.id === 'string' && isUUID(row.id) &&
    typeof row.projectId === 'string' && isUUID(row.projectId) &&
    isString(row.status) && TASK_STATUSES.includes(row.status as TaskStatus) &&
    typeof row.priority === 'string' && ['critical', 'high', 'medium', 'low'].includes(row.priority) &&
    row.createdAt instanceof Date && Number.isFinite(row.createdAt.getTime()) &&
    row.updatedAt instanceof Date && Number.isFinite(row.updatedAt.getTime());
}
export const EMERGENCY_DIGEST_TITLE = '[Title withheld: emergency metadata-only digest]';

