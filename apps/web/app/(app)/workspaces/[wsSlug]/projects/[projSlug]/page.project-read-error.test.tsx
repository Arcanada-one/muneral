import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import apiClient from '@/lib/api/client';
import ProjectPage from './page';

const fixtures = vi.hoisted(() => ({
  params: { wsSlug: 'workspace', projSlug: 'project' },
  setCurrentProject: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useParams: () => fixtures.params,
}));

vi.mock('@/lib/api/client', () => ({
  default: { get: vi.fn() },
}));

vi.mock('@/lib/api/tasks', () => ({
  useTasks: () => ({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }),
}));

vi.mock('@/store/project', () => ({
  useProjectStore: () => ({ setCurrentProject: fixtures.setCurrentProject }),
}));

vi.mock('@/components/kanban/KanbanBoard', () => ({ KanbanBoard: () => null }));
vi.mock('@/components/project/ProjectRepository', () => ({ ProjectRepository: () => null }));

const workspaceId = '33333333-3333-4333-8333-333333333333';
const otherWorkspaceId = '44444444-4444-4444-8444-444444444444';
const projectId = '22222222-2222-4222-8222-222222222222';
const otherProjectId = '55555555-5555-4555-8555-555555555555';

function workspace(id: string, slug: string) {
  return { id, slug, name: `${slug} workspace`, createdAt: '2026-10-01T00:00:00.000Z' };
}

function project(id: string, projectSlug: string, projectWorkspaceId: string, name: string) {
  return {
    id,
    slug: projectSlug,
    name,
    workspaceId: projectWorkspaceId,
    repoUrl: null,
    status: 'active',
    createdAt: '2026-10-01T00:00:00.000Z',
  };
}

const workspaces = [workspace(workspaceId, 'workspace'), workspace(otherWorkspaceId, 'other-workspace')];
const queryClients: QueryClient[] = [];

function makeQueryClient() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: 0 } },
  });
  queryClients.push(queryClient);
  return queryClient;
}

function renderPage(queryClient = makeQueryClient()) {
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ProjectPage />
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}

const get = vi.mocked(apiClient.get);

beforeEach(() => {
  fixtures.params = { wsSlug: 'workspace', projSlug: 'project' };
  get.mockReset();
});

afterEach(() => {
  cleanup();
  queryClients.forEach((queryClient) => queryClient.clear());
  queryClients.length = 0;
  vi.clearAllMocks();
});

describe('project read failure feedback', () => {
  it('keeps the initial project read on the loading state while the existing GET is pending', async () => {
    let resolveWorkspaces!: (value: { data: typeof workspaces }) => void;
    get
      .mockImplementationOnce(() => new Promise((resolve) => { resolveWorkspaces = resolve; }) as never)
      .mockResolvedValueOnce({ data: [project(projectId, 'project', workspaceId, 'Example project')] } as never);

    renderPage();

    expect(screen.getByText('Loading project...')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await act(async () => {
      resolveWorkspaces({ data: workspaces });
    });
    expect(await screen.findByRole('heading', { name: 'Example project' })).toBeInTheDocument();
  });

  it('offers an accessible manual retry after the existing project read fails', async () => {
    get
      .mockResolvedValueOnce({ data: workspaces } as never)
      .mockRejectedValueOnce(new Error('read failed'))
      .mockResolvedValueOnce({ data: workspaces } as never)
      .mockResolvedValueOnce({ data: [project(projectId, 'project', workspaceId, 'Example project')] } as never);

    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent(/project.*unavailable/i);
    expect(screen.getByRole('button', { name: /retry loading project/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /retry loading project/i }));

    expect(await screen.findByRole('heading', { name: 'Example project' })).toBeInTheDocument();
    expect(get.mock.calls.map(([path]) => path)).toEqual([
      '/workspaces',
      `/projects/workspace/${workspaceId}`,
      '/workspaces',
      `/projects/workspace/${workspaceId}`,
    ]);
  });

  it('removes the retry action while that project read is pending', async () => {
    let resolveProjectRead!: (value: { data: ReturnType<typeof project>[] }) => void;
    get
      .mockResolvedValueOnce({ data: workspaces } as never)
      .mockRejectedValueOnce(new Error('read failed'))
      .mockResolvedValueOnce({ data: workspaces } as never)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveProjectRead = resolve; }) as never);

    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('alert');

    const retry = screen.getByRole('button', { name: /retry loading project/i });
    await user.click(retry);

    expect(await screen.findByText('Loading project...')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry loading project/i })).not.toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(4);

    await act(async () => {
      resolveProjectRead({ data: [project(projectId, 'project', workspaceId, 'Example project')] });
    });
    expect(await screen.findByRole('heading', { name: 'Example project' })).toBeInTheDocument();
  });

  it('does not show a late retry result from the previous project route', async () => {
    let resolveFirstProject!: (value: { data: ReturnType<typeof project>[] }) => void;
    get
      .mockResolvedValueOnce({ data: workspaces } as never)
      .mockRejectedValueOnce(new Error('read failed'))
      .mockResolvedValueOnce({ data: workspaces } as never)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirstProject = resolve; }) as never)
      .mockResolvedValueOnce({ data: workspaces } as never)
      .mockResolvedValueOnce({ data: [project(otherProjectId, 'other-project', otherWorkspaceId, 'Other project')] } as never);

    const queryClient = makeQueryClient();
    const user = userEvent.setup();
    const view = renderPage(queryClient);
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: /retry loading project/i }));
    expect(await screen.findByText('Loading project...')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry loading project/i })).not.toBeInTheDocument();

    fixtures.params = { wsSlug: 'other-workspace', projSlug: 'other-project' };
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <ProjectPage />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('heading', { name: 'Other project' })).toBeInTheDocument();

    await act(async () => {
      resolveFirstProject({ data: [project(projectId, 'project', workspaceId, 'Late old project')] });
    });
    expect(screen.getByRole('heading', { name: 'Other project' })).toBeInTheDocument();
    expect(screen.queryByText('Late old project')).not.toBeInTheDocument();
  });

  it('keeps cached project details visible when a background refresh fails', async () => {
    get
      .mockResolvedValueOnce({ data: workspaces } as never)
      .mockResolvedValueOnce({ data: [project(projectId, 'project', workspaceId, 'Cached project')] } as never)
      .mockResolvedValueOnce({ data: workspaces } as never)
      .mockRejectedValueOnce(new Error('private server detail'));

    const queryClient = makeQueryClient();
    renderPage(queryClient);
    expect(await screen.findByRole('heading', { name: 'Cached project' })).toBeInTheDocument();

    await queryClient.invalidateQueries({ queryKey: ['workspaces', 'workspace', 'projects', 'project'] });

    expect(screen.getByRole('heading', { name: 'Cached project' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps the generic unavailable alert for failures without exposing server details', async () => {
    get
      .mockResolvedValueOnce({ data: workspaces } as never)
      .mockRejectedValueOnce(new Error('private server detail'));
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('Project details are unavailable.');
    expect(screen.queryByText('private server detail')).not.toBeInTheDocument();
  });
});
