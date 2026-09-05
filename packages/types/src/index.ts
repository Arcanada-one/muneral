// Muneral Arcana — Shared TypeScript types

export type TaskStatus =
  | 'todo'
  | 'in_progress'
  | 'review'
  | 'blocked'
  | 'done'
  | 'cancelled'
  // MUN-0043 (DEC-AUP-0014 rule 3): a card that LEFT THE BOARD. Terminal and
  // unverified, and deliberately not a synonym for `done` — an archive step
  // records where the card went, not that the work was finished and checked.
  | 'archived';

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

// Task state machine — valid transitions.
//
// `archived` is reachable only from the two statuses where the card is already
// off the working set (`done`, `cancelled`): archiving is the act of filing a
// settled card away, not a way to abandon live work — that is what `cancelled`
// is for. Leaving it is `todo`, the same way `cancelled` reopens, so an
// unarchived card rejoins the board without inheriting a completion claim.
export const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  todo: ['in_progress', 'cancelled'],
  in_progress: ['review', 'blocked', 'todo', 'cancelled'],
  review: ['in_progress', 'done', 'blocked'],
  blocked: ['in_progress', 'cancelled'],
  done: ['in_progress', 'archived'],
  cancelled: ['todo', 'archived'],
  archived: ['todo'],
};

export function isValidTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Every task status, at runtime.
 *
 * Derived from `TASK_TRANSITIONS` rather than written out a second time: that
 * map is typed `Record<TaskStatus, ...>`, so a status added to the union cannot
 * compile without an entry, and it then appears here — and in every validator
 * built on this constant — without anyone having to remember. MUN-0043 added
 * `archived` to a union that three DTOs had each hard-coded separately; this
 * exists so the next addition cannot be half-applied the same way.
 */
export const TASK_STATUSES: readonly TaskStatus[] = Object.keys(
  TASK_TRANSITIONS,
) as TaskStatus[];

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
