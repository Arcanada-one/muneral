import { z } from 'zod';
import { TASK_STATUSES, type TaskStatus } from '@muneral/types';

const id = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
export const transcriptionLink = z.object({jobId: id, producerRoute: z.string().max(2048)}).superRefine((value, ctx) => {
  try {
    const url = new URL(value.producerRoute); const entries = [...url.searchParams.entries()];
    if (/[\s\x00-\x1f\x7f]/.test(value.producerRoute) || !/^https:\/\/[^/\\?#]+(?:\/|$)/i.test(value.producerRoute) || value.producerRoute.includes('\\') || url.protocol !== 'https:' || url.username || url.password || url.hash || url.pathname !== '/v1/jobs/' + value.jobId + '/result' || entries.length !== 1 || entries[0][0] !== 'format' || !['txt', 'srt', 'vtt', 'json'].includes(entries[0][1])) throw new Error('route');
  } catch { ctx.addIssue({code: z.ZodIssueCode.custom, message: 'Invalid transcription producer route'}); }
});
const task = z.object({
  transcriptionLink: transcriptionLink.optional(),
  id, projectId: id, title: z.string(), status: z.custom<TaskStatus>((value) => TASK_STATUSES.includes(value as TaskStatus)),
  priority: z.enum(['critical', 'high', 'medium', 'low']), actorType: z.enum(['human', 'agent']).nullable(),
  createdAt: timestamp, updatedAt: timestamp,
  description: z.string().nullable().optional(), tags: z.array(z.string()).optional(),
  estimateHours: z.union([z.number().finite(), z.string().regex(/^-?\d+(?:\.\d+)?$/)]).nullable().optional(), dueDate: z.string().nullable().optional(),
  parentId: id.nullable().optional(),
});
const workspace = z.object({ id, slug: z.string().min(1), name: z.string(), createdAt: timestamp,
  description: z.string().nullable().optional(), memberCount: z.number().int().nonnegative().optional() });
const project = z.object({ id, workspaceId: id, slug: z.string().min(1), name: z.string(), createdAt: timestamp,
  description: z.string().nullable().optional(), status: z.enum(['active', 'archived']).optional(),
  taskCount: z.number().int().nonnegative().optional() });
const checklist = z.object({ id, taskId: id, text: z.string(), checked: z.boolean(),
  position: z.number().int().nullable() });
const activity = z.object({ id, taskId: id, actorId: id, actorType: z.enum(['human', 'agent']),
  actorName: z.string().optional(), action: z.string(), createdAt: timestamp,
  payload: z.record(z.unknown()).nullable().optional() });
const dependency = z.object({ id, fromTaskId: id, toTaskId: id, type: z.string() });

function read<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`${label} response is unavailable: invalid response shape`);
  return parsed.data;
}
export const readTask = (value: unknown) => read(task, value, 'Task');
export const readWorkspaces = (value: unknown) => read(z.array(workspace), value, 'Workspaces');
export const readProjects = (value: unknown) => read(z.array(project), value, 'Projects');
export const readDependencies = (value: unknown) => read(z.array(dependency), value, 'Dependencies');
export function readChecklist(value: unknown) {
  return read(z.array(checklist), value, 'Checklist').map(({ text, position, ...item }) =>
    ({ ...item, label: text, order: position }));
}
export function readTaskPage(value: unknown) {
  const page = read(z.object({ items: z.array(task), total: z.number().int().nonnegative(),
    limit: z.number().int().min(1).max(200), offset: z.number().int().nonnegative() }), value, 'Tasks');
  if (page.offset % page.limit !== 0 || page.items.length > page.limit || page.items.length > page.total)
    throw new Error('Tasks response is unavailable: invalid pagination');
  return { data: page.items, total: page.total, limit: page.limit, page: page.offset / page.limit + 1 };
}
export function readActivity(value: unknown) {
  return read(z.object({ data: z.array(activity), total: z.number().int().nonnegative(),
    page: z.number().int().positive(), limit: z.number().int().positive() }), value, 'Activity');
}
export function uniqueSlug<T extends { slug: string }>(rows: T[], slug: string, label: string): T {
  const matches = rows.filter(row => row.slug === slug);
  if (matches.length !== 1) throw new Error(`${label} is unavailable`);
  return matches[0];
}
