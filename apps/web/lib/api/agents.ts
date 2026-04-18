import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import apiClient from './client';
import type { PaginatedResult } from '@muneral/types';

export interface Agent {
  id: string;
  name: string;
  description?: string;
  workspaceId: string;
  apiKeyId?: string;
  createdAt: string;
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  workspaceId: string;
  agentId?: string;
  lastUsedAt?: string;
  createdAt: string;
  expiresAt?: string;
}

export interface Webhook {
  id: string;
  url: string;
  events: string[];
  workspaceId: string;
  active: boolean;
  createdAt: string;
}

export interface ActivityEntry {
  id: string;
  agentId: string;
  agentName: string;
  action: string;
  taskId?: string;
  taskTitle?: string;
  payload?: Record<string, unknown>;
  createdAt: string;
}

async function fetchAgents(wsSlug: string): Promise<Agent[]> {
  const res = await apiClient.get<PaginatedResult<Agent>>(
    `/workspaces/${wsSlug}/agents`,
  );
  return res.data.data;
}

async function fetchApiKeys(wsSlug: string): Promise<ApiKey[]> {
  const res = await apiClient.get<ApiKey[]>(`/workspaces/${wsSlug}/api-keys`);
  return res.data;
}

async function fetchWebhooks(wsSlug: string): Promise<Webhook[]> {
  const res = await apiClient.get<Webhook[]>(`/workspaces/${wsSlug}/webhooks`);
  return res.data;
}

async function fetchAgentActivity(
  wsSlug: string,
  limit = 50,
): Promise<ActivityEntry[]> {
  const res = await apiClient.get<ActivityEntry[]>(
    `/workspaces/${wsSlug}/activity?limit=${limit}`,
  );
  return res.data;
}

export function useAgents(wsSlug: string) {
  return useQuery({
    queryKey: ['workspaces', wsSlug, 'agents'],
    queryFn: () => fetchAgents(wsSlug),
    enabled: Boolean(wsSlug),
  });
}

export function useApiKeys(wsSlug: string) {
  return useQuery({
    queryKey: ['workspaces', wsSlug, 'api-keys'],
    queryFn: () => fetchApiKeys(wsSlug),
    enabled: Boolean(wsSlug),
  });
}

export function useWebhooks(wsSlug: string) {
  return useQuery({
    queryKey: ['workspaces', wsSlug, 'webhooks'],
    queryFn: () => fetchWebhooks(wsSlug),
    enabled: Boolean(wsSlug),
  });
}

export function useAgentActivity(wsSlug: string, limit = 50) {
  return useQuery({
    queryKey: ['workspaces', wsSlug, 'activity', limit],
    queryFn: () => fetchAgentActivity(wsSlug, limit),
    enabled: Boolean(wsSlug),
    refetchInterval: 30_000,
  });
}

export function useRevokeApiKey(wsSlug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (keyId: string) =>
      apiClient.delete(`/workspaces/${wsSlug}/api-keys/${keyId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspaces', wsSlug, 'api-keys'] });
    },
  });
}

export function useCreateApiKey(wsSlug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; agentId?: string; expiresAt?: string }) =>
      apiClient
        .post<ApiKey & { plaintext: string }>(`/workspaces/${wsSlug}/api-keys`, data)
        .then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspaces', wsSlug, 'api-keys'] });
    },
  });
}
