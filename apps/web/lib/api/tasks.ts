import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import apiClient from './client';
import { readTask, readTaskPage, readChecklist, readDependencies, readActivity } from './read-contract';
import type {
  TaskStatus,
  TaskPriority,
  ActorType,
  PaginatedResult,
} from '@muneral/types';

export interface Task {
  id: string;
  title: string;
  description?: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  projectId: string;
  parentTaskId?: string;
  estimateHours?: number | string | null;
  dueDate?: string | null;
  tags?: string[];
  actorType: ActorType | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskFilters {
  status?: TaskStatus;
  priority?: TaskPriority;
  actorType?: ActorType;
  page?: number;
  limit?: number;
}

export interface ChecklistItem {
  id: string;
  taskId: string;
  label: string;
  checked: boolean;
  order: number | null;
}

export interface TaskDependency {
  id: string;
  fromTaskId: string;
  toTaskId: string;
  type: string;
}

export interface ActivityLogEntry {
  id: string;
  taskId: string;
  actorId: string;
  actorName?: string;
  actorType: ActorType;
  action: string;
  payload?: Record<string, unknown> | null;
  createdAt: string;
}

async function fetchTasks(
  projectId: string,
  filters: TaskFilters = {},
): Promise<PaginatedResult<Task>> {
  if (Object.keys(filters).some(key => !['status', 'page', 'limit'].includes(key)) || filters.priority !== undefined || filters.actorType !== undefined)
    throw new Error('Task filter is unavailable: unsupported filter');
  const page = filters.page ?? 1;
  const limit = filters.limit ?? 50;
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger((page - 1) * limit))
    throw new Error('Task filter is unavailable: invalid pagination');
  const params = new URLSearchParams({ projectId, limit: String(limit), offset: String((page - 1) * limit) });
  if (filters.status) params.set('status', filters.status);
  const res = await apiClient.get<unknown>(`/tasks?${params.toString()}`);
  const result = readTaskPage(res.data);
  if (result.limit !== limit || result.page !== page || result.data.some(task => task.projectId !== projectId || (filters.status !== undefined && task.status !== filters.status)))
    throw new Error('Tasks response is unavailable: invalid query binding');
  return result;
}

async function fetchTask(taskId: string): Promise<Task> {
  const res = await apiClient.get<Task>(`/tasks/${taskId}`);
  return readTask(res.data);
}

async function fetchChecklist(taskId: string): Promise<ChecklistItem[]> {
  const res = await apiClient.get<ChecklistItem[]>(`/tasks/${taskId}/checklist`);
  return readChecklist(res.data);
}

async function fetchDependencies(taskId: string): Promise<TaskDependency[]> {
  const res = await apiClient.get<TaskDependency[]>(`/tasks/${taskId}/dependencies`);
  return readDependencies(res.data);
}

async function fetchActivity(
  taskId: string,
  page = 1,
  limit = 20,
): Promise<PaginatedResult<ActivityLogEntry>> {
  const res = await apiClient.get<PaginatedResult<ActivityLogEntry>>(
    `/tasks/${taskId}/activity?page=${page}&limit=${limit}`,
  );
  return readActivity(res.data);
}

export function useTasks(projectId: string, filters: TaskFilters = {}) {
  return useQuery({
    queryKey: ['tasks', 'project', projectId, filters],
    queryFn: () => fetchTasks(projectId, filters),
    enabled: Boolean(projectId),
  });
}

export function useTask(taskId: string) {
  return useQuery({
    queryKey: ['tasks', taskId],
    queryFn: () => fetchTask(taskId),
    enabled: Boolean(taskId),
  });
}

export function useChecklist(taskId: string) {
  return useQuery({
    queryKey: ['tasks', taskId, 'checklist'],
    queryFn: () => fetchChecklist(taskId),
    enabled: Boolean(taskId),
  });
}

export function useDependencies(taskId: string) {
  return useQuery({
    queryKey: ['tasks', taskId, 'dependencies'],
    queryFn: () => fetchDependencies(taskId),
    enabled: Boolean(taskId),
  });
}

export function useActivity(taskId: string, page = 1) {
  return useQuery({
    queryKey: ['tasks', taskId, 'activity', page],
    queryFn: () => fetchActivity(taskId, page),
    enabled: Boolean(taskId),
  });
}

export function useUpdateTaskStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, status }: { taskId: string; status: TaskStatus }) =>
      apiClient
        .patch<Task>(`/tasks/${taskId}/status`, { status })
        .then((r) => r.data),
    onSuccess: (_, { taskId }) => {
      queryClient.invalidateQueries({ queryKey: ['tasks', taskId] });
      queryClient.invalidateQueries({ queryKey: ['tasks', 'project'] });
    },
  });
}

export function useCreateTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (
      data: Omit<Task, 'id' | 'createdAt' | 'updatedAt' | 'tags' | 'description' | 'estimateHours' | 'dueDate' | 'actorType'> & { tags?: string[]; description?: string; estimateHours?: number; dueDate?: string; actorType: ActorType },
    ) => apiClient.post<Task>('/tasks', data).then((r) => r.data),
    onSuccess: (task) => {
      queryClient.invalidateQueries({ queryKey: ['tasks', 'project', task.projectId] });
    },
  });
}

export function useToggleChecklistItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      taskId,
      itemId,
      checked,
    }: {
      taskId: string;
      itemId: string;
      checked: boolean;
    }) =>
      apiClient
        .patch<ChecklistItem>(`/tasks/${taskId}/checklist/${itemId}`, { checked })
        .then((r) => r.data),
    onSuccess: (_, { taskId }) => {
      queryClient.invalidateQueries({ queryKey: ['tasks', taskId, 'checklist'] });
    },
  });
}
