import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import apiClient from './client';
import type {
  TaskStatus,
  TaskPriority,
  ActorType,
  PaginatedResult,
} from '@muneral/types';

export interface Task {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  projectId: string;
  parentTaskId?: string;
  estimateHours?: number;
  dueDate?: string;
  tags: string[];
  actorType: ActorType;
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
  order: number;
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
  actorName: string;
  actorType: ActorType;
  action: string;
  payload?: Record<string, unknown>;
  createdAt: string;
}

async function fetchTasks(
  projectId: string,
  filters: TaskFilters = {},
): Promise<PaginatedResult<Task>> {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.priority) params.set('priority', filters.priority);
  if (filters.actorType) params.set('actorType', filters.actorType);
  if (filters.page) params.set('page', String(filters.page));
  if (filters.limit) params.set('limit', String(filters.limit));

  const res = await apiClient.get<PaginatedResult<Task>>(
    `/tasks/project/${projectId}?${params.toString()}`,
  );
  return res.data;
}

async function fetchTask(taskId: string): Promise<Task> {
  const res = await apiClient.get<Task>(`/tasks/${taskId}`);
  return res.data;
}

async function fetchChecklist(taskId: string): Promise<ChecklistItem[]> {
  const res = await apiClient.get<ChecklistItem[]>(`/tasks/${taskId}/checklist`);
  return res.data;
}

async function fetchDependencies(taskId: string): Promise<TaskDependency[]> {
  const res = await apiClient.get<TaskDependency[]>(`/tasks/${taskId}/dependencies`);
  return res.data;
}

async function fetchActivity(
  taskId: string,
  page = 1,
  limit = 20,
): Promise<PaginatedResult<ActivityLogEntry>> {
  const res = await apiClient.get<PaginatedResult<ActivityLogEntry>>(
    `/tasks/${taskId}/activity?page=${page}&limit=${limit}`,
  );
  return res.data;
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
      data: Omit<Task, 'id' | 'createdAt' | 'updatedAt' | 'tags'> & { tags?: string[] },
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
