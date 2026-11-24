import { z } from 'zod';
import { TASK_ACTIVITY_MAX_LIMIT, TASK_STATUSES, type TaskStatus } from '@muneral/types';

// Unpaginated API collections have no contract limit. Stop on the first invalid item.
function unpaginated<T>(item: z.ZodType<T>) {
  return z.custom<unknown[]>(Array.isArray).transform((rows, ctx) => {
    const data: T[] = [];
    for (const row of rows) {
      const parsed = item.safeParse(row);
      if (!parsed.success) {
        ctx.addIssue({ code: 'custom', message: 'Invalid collection item' });
        return z.NEVER;
      }
      data.push(parsed.data);
    }
    return data;
  });
}

const id = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
const task = z.object({
  id, projectId: id, title: z.string(), status: z.custom<TaskStatus>((value) => TASK_STATUSES.includes(value as TaskStatus)),
  priority: z.enum(['critical', 'high', 'medium', 'low']), actorType: z.enum(['human', 'agent']).nullable(),
  createdAt: timestamp, updatedAt: timestamp,
  description: z.string().nullable().optional(), tags: unpaginated(z.string()).optional(),
  estimateHours: z.union([z.number().finite(), z.string().regex(/^-?\d+(?:\.\d+)?$/)]).nullable().optional(), dueDate: z.string().nullable().optional(),
  parentId: id.nullable().optional(),
});
const workspace = z.object({ id, slug: z.string().min(1), name: z.string(), createdAt: timestamp,
  description: z.string().nullable().optional(), memberCount: z.number().int().nonnegative().optional() });
const project = z.object({ id, workspaceId: id, slug: z.string().min(1), name: z.string(), createdAt: timestamp,
  repoUrl: z.string().nullable().optional(),
  description: z.string().nullable().optional(), status: z.enum(['active', 'archived']).optional(),
  taskCount: z.number().int().nonnegative().optional() });
const checklist = z.object({ id, taskId: id, text: z.string(), checked: z.boolean(),
  position: z.number().int().nullable() });
const activity = z.object({ id, taskId: id, actorId: id, actorType: z.enum(['human', 'agent']),
  actorName: z.string().optional(), action: z.string(), createdAt: timestamp,
  // Zod 4: z.record requires key + value schemas (single-arg form removed).
  payload: z.record(z.string(), z.unknown()).nullable().optional() });
const dependency = z.object({ id, fromTaskId: id, toTaskId: id, type: z.string() });
const dependencyGraphEntry = z.object({
  id,
  type: z.string(),
  direction: z.enum(['incoming', 'outgoing']),
  fromTaskId: id,
  toTaskId: id,
  otherTaskId: id,
  otherTaskTitle: z.string().nullable(),
  otherTaskTitleWithheld: z.literal(true).optional(),
  otherTaskStatus: z.string(),
});
const taskGitRef = z.object({
  id,
  taskId: id,
  type: z.enum(['repo', 'branch', 'commit']),
  url: z.string().min(1),
  ref: z.string().nullable(),
  createdAt: timestamp,
});

function read<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`${label} response is unavailable: invalid response shape`);
  return parsed.data;
}
export const readTask = (value: unknown) => read(task, value, 'Task');
export const readWorkspaces = (value: unknown) => read(unpaginated(workspace), value, 'Workspaces');
export const readProjects = (value: unknown) => read(unpaginated(project), value, 'Projects');
export const readDependencies = (value: unknown) => read(unpaginated(dependency), value, 'Dependencies');
export const readDependencyGraph = (value: unknown) => read(unpaginated(dependencyGraphEntry), value, 'Dependencies');
export function readTaskReadiness(value: unknown) {
  return read(z.object({
    taskId: id,
    dependencyCount: z.number().int().nonnegative(),
    blockedBy: unpaginated(dependencyGraphEntry),
    ready: z.boolean(),
  }), value, 'Task readiness');
}
export const readTaskGitRefs = (value: unknown) => read(unpaginated(taskGitRef), value, 'Git references');
export function readChecklist(value: unknown) {
  return read(unpaginated(checklist), value, 'Checklist').map(({ text, position, ...item }) =>
    ({ ...item, label: text, order: position }));
}
export function readTaskPage(value: unknown) {
  const page = read(z.object({ items: z.array(task).max(200), total: z.number().int().nonnegative(),
    limit: z.number().int().min(1).max(200), offset: z.number().int().nonnegative() }), value, 'Tasks');
  if (page.offset % page.limit !== 0 || page.items.length > page.limit || page.items.length > page.total)
    throw new Error('Tasks response is unavailable: invalid pagination');
  return { data: page.items, total: page.total, limit: page.limit, page: page.offset / page.limit + 1 };
}
export function readActivity(value: unknown) {
  return read(z.object({
    data: z.array(activity).max(TASK_ACTIVITY_MAX_LIMIT),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    limit: z.number().int().positive().max(TASK_ACTIVITY_MAX_LIMIT),
  }).refine(page => page.data.length <= page.limit), value, 'Activity');
}
export function uniqueSlug<T extends { slug: string }>(rows: T[], slug: string, label: string): T {
  const matches = rows.filter(row => row.slug === slug);
  if (matches.length !== 1) throw new Error(`${label} is unavailable`);
  return matches[0];
}
