import { QueryClient } from '@tanstack/react-query';
import axios from 'axios';
import type { AxiosRequestConfig } from 'axios';
import { z } from 'zod';
import apiClient from './client';
import { readTask, readWorkspaces, readProjects } from './read-contract';
import { DetailReadFailure, type DetailReadPort, type TaskSelection } from './task-detail-controller';

const key = (s: TaskSelection) => ['task-detail', s.workspaceSlug, s.projectSlug, s.taskId] as const;
/** GET-only adapter; session isolation is supplied by the provider's separate QueryClient. */
export function taskDetailReadPort(query: QueryClient): DetailReadPort {
  return {
    load: (selection, signal) => query.fetchQuery({
      queryKey: key(selection), staleTime: 0, gcTime: Infinity, retry: false,
      queryFn: async () => {
        try {
          const config: AxiosRequestConfig & {skipAuthRefresh: boolean} = {signal, skipAuthRefresh: true};
          const workspaces = readWorkspaces((await apiClient.get('/workspaces', config)).data);
          const matches = workspaces.filter(w => w.slug === selection.workspaceSlug);
          if (matches.length !== 1) throw new DetailReadFailure('denied');
          const workspace = matches[0];
          const projects = readProjects((await apiClient.get('/projects/workspace/' + workspace.id, config)).data);
          const candidates = projects.filter(p => p.slug === selection.projectSlug);
          if (projects.some(p => p.workspaceId !== workspace.id) || candidates.length !== 1)
            throw new DetailReadFailure('denied');
          const raw = (await apiClient.get('/tasks/' + encodeURIComponent(selection.taskId), config)).data;
          const task = readTask(raw);
          const revision = z.object({revision:z.number().int().nonnegative().optional()}).parse(raw).revision;
          if (task.id !== selection.taskId || task.projectId !== candidates[0].id) throw new DetailReadFailure('denied');
          return {...task, revision};
        } catch (e) {
          if (e instanceof DetailReadFailure) throw e;
          if (axios.isAxiosError(e)) {
            const status = e.response?.status;
            if (status === 401 || status === 403) throw new DetailReadFailure('denied');
            if (status === 404) throw new DetailReadFailure('missing');
            throw new DetailReadFailure('unavailable', !signal.aborted && (status === undefined || status >= 500));
          }
          throw new DetailReadFailure('unavailable');
        }
      },
    }),
    peek: selection => query.getQueryData(key(selection)),
    clear: () => { void query.cancelQueries({queryKey: ['task-detail']}); query.removeQueries({queryKey: ['task-detail']}); },
  };
}
