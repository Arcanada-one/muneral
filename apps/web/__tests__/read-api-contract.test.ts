import { renderHook, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type PropsWithChildren } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTask, useTasks, useChecklist, useActivity } from '@/lib/api/tasks';
import { useWorkspaces } from '@/lib/api/workspaces';
import { useProject } from '@/lib/api/projects';
import {
  readActivity, readChecklist, readDependencies, readDependencyGraph, readProjects,
  readTask, readTaskGitRefs, readTaskPage, readTaskReadiness, readWorkspaces, uniqueSlug,
} from '@/lib/api/read-contract';
const transport = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/lib/api/client', () => ({ default: transport }));
const taskId = '10000000-0000-4000-8000-000000000001';
const projectId = '10000000-0000-4000-8000-000000000002';
const workspaceId = '10000000-0000-4000-8000-000000000003';
const date = '2026-10-08T00:00:00.000Z';
const task = { id: taskId, projectId, title: 'Synthetic own task', status: 'todo', priority: 'medium', actorType: 'human', createdAt: date, updatedAt: date, description: null, dueDate: null, estimateHours: null };
const workspace = { id: workspaceId, slug: 'own-workspace', name: 'Own workspace', createdAt: date };
const project = { id: projectId, workspaceId, slug: 'own-project', name: 'Own project', createdAt: date };
const activity = { id: workspaceId, taskId, actorId: projectId, actorType: 'human', action: 'comment', createdAt: date, payload: null };
const dependency = { id: projectId, fromTaskId: taskId, toTaskId: workspaceId, type: 'depends_on' };
const edge = { ...dependency, direction: 'outgoing', otherTaskId: workspaceId, otherTaskTitle: null, otherTaskStatus: 'todo' };
let client: QueryClient;
function wrapper({ children }: PropsWithChildren) { return createElement(QueryClientProvider, { client }, children); }
beforeEach(() => { transport.get.mockReset(); client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); });
afterEach(() => { cleanup(); client.clear(); });
describe('read adapters on current backend shapes', () => {
  it('reads persisted task without tags through actual hook', async () => {
    transport.get.mockResolvedValue({ data: task });
    const { result } = renderHook(() => useTask(taskId), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.title).toBe(task.title); expect(result.current.data?.tags).toBeUndefined();
    expect(transport.get).toHaveBeenCalledWith(`/tasks/${taskId}`);
  });
  it.each([{ estimateHours: '1.25', dueDate: '2026-10-08', actorType: null }, { estimateHours: null, dueDate: 'source due text', actorType: 'human' }])('preserves legal nullable/decimal/date-text task wire %j', value => {
    expect(readTask({ ...task, ...value })).toMatchObject(value);
  });
  it('refuses malformed decimal wire without coercion', () => expect(() => readTask({ ...task, estimateHours: '1.25oops' })).toThrow(/invalid response shape/));
  it('preserves denied read error', async () => {
    const denied = new Error('synthetic HTTP403'); transport.get.mockRejectedValue(denied);
    const { result } = renderHook(() => useTask(taskId), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true)); expect(result.current.error).toBe(denied);
  });
  it('reads raw workspace array without invented count', async () => {
    transport.get.mockResolvedValue({ data: [workspace] });
    const { result } = renderHook(useWorkspaces, { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.[0].id).toBe(workspaceId); expect(result.current.data?.[0].memberCount).toBeUndefined();
  });
  it('resolves slugs using accessible workspace and actual project UUID route', async () => {
    transport.get.mockImplementation(async (url: string) => ({ data: url === '/workspaces' ? [workspace] : [project] }));
    const { result } = renderHook(() => useProject(workspace.slug, project.slug), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.id).toBe(projectId); expect(result.current.data?.status).toBeUndefined();
    expect(transport.get.mock.calls.map(x => x[0])).toEqual(['/workspaces', `/projects/workspace/${workspaceId}`]);
  });
  it('refuses absent workspace before project read', async () => {
    transport.get.mockResolvedValue({ data: [] });
    const { result } = renderHook(() => useProject('foreign', project.slug), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true)); expect(transport.get).toHaveBeenCalledTimes(1);
  });
  it('refuses project with mismatched workspace binding', async () => {
    transport.get.mockImplementation(async (url: string) => ({ data: url === '/workspaces' ? [workspace] : [{ ...project, workspaceId: taskId }] }));
    const { result } = renderHook(() => useProject(workspace.slug, project.slug), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
  it('preserves status/project filters and exact page/offset', async () => {
    transport.get.mockResolvedValue({ data: { items: [{ ...task, status: 'blocked' }], total: 12, limit: 5, offset: 5 } });
    const { result } = renderHook(() => useTasks(projectId, { status: 'blocked', page: 2, limit: 5 }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const requested = new URL(transport.get.mock.calls[0][0], 'http://synthetic');
    expect(requested.pathname).toBe('/tasks'); expect(Object.fromEntries(requested.searchParams)).toEqual({ projectId, limit: '5', offset: '5', status: 'blocked' });
    expect(result.current.data).toMatchObject({ data: [{ ...task, status: 'blocked' }], total: 12, page: 2, limit: 5 });
  });
  it.each([{ priority: 'high' as const }, { actorType: 'human' as const }, { page: 0 }, { limit: 201 }, { page: Number.MAX_SAFE_INTEGER }])('refuses unsupported filters/paging before wire %j', async filters => {
    const { result } = renderHook(() => useTasks(projectId, filters), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true)); expect(transport.get).not.toHaveBeenCalled();
  });
  it.each([{ ...task, projectId: workspaceId }, { ...task, status: 'done' }])('refuses rows violating requested project/status binding %j', async row => {
    transport.get.mockResolvedValue({ data: { items: [row], total: 1, limit: 50, offset: 0 } });
    const { result } = renderHook(() => useTasks(projectId, { status: 'todo' }), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
  it('maps persisted checklist text and nullable position', async () => {
    transport.get.mockResolvedValue({ data: [{ id: workspaceId, taskId, text: 'Real label', checked: false, position: null }] });
    const { result } = renderHook(() => useChecklist(taskId), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true)); expect(result.current.data?.[0]).toMatchObject({ label: 'Real label', order: null });
  });
  it('reads activity without inventing actorName', async () => {
    transport.get.mockResolvedValue({ data: { data: [{ id: workspaceId, taskId, actorId: projectId, actorType: 'human', action: 'comment', createdAt: date, payload: null }], total: 1, page: 1, limit: 20 } });
    const { result } = renderHook(() => useActivity(taskId), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true)); expect(result.current.data?.data[0].actorName).toBeUndefined();
  });
  it.each([1, 10_000])('preserves an empty activity page with echoed limit %i', limit => {
    const page = { data: [], total: 0, page: 1, limit };
    expect(readActivity(page)).toEqual(page);
  });
  it('preserves a populated activity page at the 10,000-row boundary', () => {
    const page = { data: Array(10_000).fill(activity), total: 10_001, page: 1, limit: 10_000 };
    const result = readActivity(page);
    expect(result).toMatchObject({ total: 10_001, page: 1, limit: 10_000 });
    expect(result.data).toHaveLength(10_000);
  });
});
describe('unpaginated API collections', () => {
  it.each([
    { name: 'workspaces', reader: readWorkspaces, row: workspace },
    { name: 'projects', reader: readProjects, row: project },
    { name: 'dependencies', reader: readDependencies, row: dependency },
    { name: 'dependency graph', reader: readDependencyGraph, row: edge },
    { name: 'readiness blockers', reader: (rows: unknown[]) => readTaskReadiness({
      taskId, dependencyCount: rows.length, blockedBy: rows, ready: false,
    }).blockedBy, row: edge },
    { name: 'Git references', reader: readTaskGitRefs, row: { id: workspaceId, taskId, type: 'repo', url: 'https://example.test/repo', ref: null, createdAt: date } },
    { name: 'checklist', reader: readChecklist, row: { id: workspaceId, taskId, text: 'Real label', checked: false, position: null } },
  ])('reads $name beyond 10,000 rows and rejects invalid items', ({ reader, row }) => {
    expect(reader(Array(10_001).fill(row))).toHaveLength(10_001);
    expect(() => reader([row, {}])).toThrow(/invalid response shape/);
  });

  it('reads tasks with more than 200 tags and rejects non-string tags', () => {
    const tags = Array.from({ length: 201 }, (_, index) => `tag-${index}`);
    expect(readTask({ ...task, tags }).tags).toEqual(tags);
    expect(() => readTask({ ...task, tags: [...tags, 1] })).toThrow(/invalid response shape/);
  });
});
describe('invalid bodies never become successful empty reads', () => {
  it.each([{}, { ...task, status: 'unknown' }, { ...task, tags: 'wrong' }, { ...task, title: 42 }])('refuses malformed task %j', value => expect(() => readTask(value)).toThrow(/invalid response shape/));
  it.each([undefined, {}, { data: [] }, [{ ...workspace, id: 'invalid' }]])('refuses malformed workspaces %j', value => expect(() => readWorkspaces(value)).toThrow(/invalid response shape/));
  it.each([{ data: [] }, { items: [], total: 0, limit: 0, offset: 0 }, { items: [task], total: 0, limit: 5, offset: 0 }, { items: [], total: 2, limit: 5, offset: 1 }])('refuses malformed task page %j', value => expect(() => readTaskPage(value)).toThrow(/unavailable/));
  it('preserves empty page with nonzero total', () => expect(readTaskPage({ items: [], total: 10, limit: 5, offset: 10 })).toEqual({ data: [], total: 10, limit: 5, page: 3 }));
  it('refuses duplicate slug identity', () => expect(() => uniqueSlug([workspace, workspace], workspace.slug, 'Workspace')).toThrow(/unavailable/));
  it('refuses malformed activity rows', () => expect(() => readActivity({ data: [{ action: 'comment' }], total: 1, page: 1, limit: 20 })).toThrow(/invalid response shape/));
  it.each([0, -1, 1.5, 10_001, Number.MAX_SAFE_INTEGER + 1])('refuses an invalid activity limit %i', limit => {
    expect(() => readActivity({ data: [], total: 0, page: 1, limit })).toThrow(/invalid response shape/);
  });
  it.each([[1, 2], [10_000, 10_001]])('refuses activity limit %i with %i returned rows', (limit, count) => {
    const page = { data: Array(count).fill(activity), total: count, page: 1, limit };
    expect(() => readActivity(page)).toThrow(/invalid response shape/);
  });
});
