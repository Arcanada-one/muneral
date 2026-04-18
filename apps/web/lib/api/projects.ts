import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import apiClient from './client';
import type { PaginatedResult } from '@muneral/types';

export interface Project {
  id: string;
  slug: string;
  name: string;
  description?: string;
  workspaceId: string;
  status: 'active' | 'archived';
  taskCount: number;
  createdAt: string;
}

export interface Sprint {
  id: string;
  name: string;
  projectId: string;
  startDate: string;
  endDate: string;
  status: 'planned' | 'active' | 'completed';
}

export interface Milestone {
  id: string;
  title: string;
  projectId: string;
  dueDate?: string;
  status: 'open' | 'closed';
  taskCount: number;
}

async function fetchProjects(wsSlug: string): Promise<Project[]> {
  const res = await apiClient.get<PaginatedResult<Project>>(
    `/workspaces/${wsSlug}/projects`,
  );
  return res.data.data;
}

async function fetchProject(wsSlug: string, projSlug: string): Promise<Project> {
  const res = await apiClient.get<Project>(`/workspaces/${wsSlug}/projects/${projSlug}`);
  return res.data;
}

async function fetchSprints(projectId: string): Promise<Sprint[]> {
  const res = await apiClient.get<PaginatedResult<Sprint>>(
    `/projects/${projectId}/sprints`,
  );
  return res.data.data;
}

async function fetchMilestones(projectId: string): Promise<Milestone[]> {
  const res = await apiClient.get<PaginatedResult<Milestone>>(
    `/projects/${projectId}/milestones`,
  );
  return res.data.data;
}

export function useProjects(wsSlug: string) {
  return useQuery({
    queryKey: ['workspaces', wsSlug, 'projects'],
    queryFn: () => fetchProjects(wsSlug),
    enabled: Boolean(wsSlug),
  });
}

export function useProject(wsSlug: string, projSlug: string) {
  return useQuery({
    queryKey: ['workspaces', wsSlug, 'projects', projSlug],
    queryFn: () => fetchProject(wsSlug, projSlug),
    enabled: Boolean(wsSlug) && Boolean(projSlug),
  });
}

export function useSprints(projectId: string) {
  return useQuery({
    queryKey: ['projects', projectId, 'sprints'],
    queryFn: () => fetchSprints(projectId),
    enabled: Boolean(projectId),
  });
}

export function useMilestones(projectId: string) {
  return useQuery({
    queryKey: ['projects', projectId, 'milestones'],
    queryFn: () => fetchMilestones(projectId),
    enabled: Boolean(projectId),
  });
}

export function useCreateProject(wsSlug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; slug: string; description?: string }) =>
      apiClient
        .post<Project>(`/workspaces/${wsSlug}/projects`, data)
        .then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspaces', wsSlug, 'projects'] });
    },
  });
}
