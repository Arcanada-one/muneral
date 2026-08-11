// Muneral Arcana — Shared TypeScript types

export type TaskStatus =
  | 'todo'
  | 'in_progress'
  | 'review'
  | 'blocked'
  | 'done'
  | 'cancelled';

export type TaskPriority = 'critical' | 'high' | 'medium' | 'low';

export type ActorType = 'human' | 'agent';

export type WorkspaceMemberRole = 'owner' | 'manager' | 'developer' | 'viewer';

export type TaskDependencyType =
  | 'depends_on'
  | 'blocks'
  | 'related_to'
  | 'duplicates';

export type GitRefType = 'repo' | 'branch' | 'commit';

export type TaskAgentRole = 'lead' | 'reviewer' | 'executor';

export interface Actor {
  type: ActorType;
  id: string;
  name: string;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

// Task state machine — valid transitions
export const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  todo: ['in_progress', 'cancelled'],
  in_progress: ['review', 'blocked', 'todo', 'cancelled'],
  review: ['in_progress', 'done', 'blocked'],
  blocked: ['in_progress', 'cancelled'],
  done: ['in_progress'],
  cancelled: ['todo'],
};

export function isValidTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from]?.includes(to) ?? false;
}

// Role hierarchy for RBAC (higher number = higher privilege)
export const ROLE_HIERARCHY: Record<WorkspaceMemberRole, number> = {
  viewer: 1,
  developer: 2,
  manager: 3,
  owner: 4,
};

export function hasRole(
  userRole: WorkspaceMemberRole,
  requiredRole: WorkspaceMemberRole,
): boolean {
  return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[requiredRole];
}

export interface DatarimTask {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  description?: string;
  dueDate?: string;
  estimateHours?: number;
  tags?: string[];
  actorType: ActorType;
}

export interface DatarimExport {
  projectName: string;
  lastUpdated: string;
  activeTasks: DatarimTask[];
  doneTasks: DatarimTask[];
}
