import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import apiClient from './client';
import type { PaginatedResult } from '@muneral/types';

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  description?: string;
  memberCount: number;
  createdAt: string;
}

export interface WorkspaceMember {
  id: string;
  userId: string;
  userName: string;
  role: string;
  joinedAt: string;
}

async function fetchWorkspaces(): Promise<Workspace[]> {
  const res = await apiClient.get<PaginatedResult<Workspace>>('/workspaces');
  return res.data.data;
}

async function fetchWorkspace(slug: string): Promise<Workspace> {
  const res = await apiClient.get<Workspace>(`/workspaces/${slug}`);
  return res.data;
}

async function fetchWorkspaceMembers(wsSlug: string): Promise<WorkspaceMember[]> {
  const res = await apiClient.get<PaginatedResult<WorkspaceMember>>(
    `/workspaces/${wsSlug}/members`,
  );
  return res.data.data;
}

export function useWorkspaces() {
  return useQuery({
    queryKey: ['workspaces'],
    queryFn: fetchWorkspaces,
  });
}

export function useWorkspace(slug: string) {
  return useQuery({
    queryKey: ['workspaces', slug],
    queryFn: () => fetchWorkspace(slug),
    enabled: Boolean(slug),
  });
}

export function useWorkspaceMembers(wsSlug: string) {
  return useQuery({
    queryKey: ['workspaces', wsSlug, 'members'],
    queryFn: () => fetchWorkspaceMembers(wsSlug),
    enabled: Boolean(wsSlug),
  });
}

export function useCreateWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; slug: string; description?: string }) =>
      apiClient.post<Workspace>('/workspaces', data).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspaces'] });
    },
  });
}
