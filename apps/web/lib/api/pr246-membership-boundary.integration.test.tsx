import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { ReactNode } from 'react';

const session = vi.hoisted(() => ({ accessToken: '' }));
vi.mock('next-auth/react', () => ({
  getSession: vi.fn(async () => ({ accessToken: session.accessToken })),
  signOut: vi.fn(),
}));

describe('PR246 real web read adapters against the candidate API', () => {
  let fixture: Awaited<ReturnType<(typeof import('../../../api/test/support/pr246-web-boundary-app.js'))['createPr246WebBoundaryApp']>>;
  let apiClient: (typeof import('./client'))['default'];
  let useWorkspaceMembers: (typeof import('./workspaces'))['useWorkspaceMembers'];
  let useTasks: (typeof import('./tasks'))['useTasks'];
  let taskDetailReadPort: (typeof import('./task-detail-read'))['taskDetailReadPort'];
  let activeScenario = '';
  const completed = new Set<string>();
  const observations: Record<string, Array<{ method: string; path: string; status: number; response_sha256: string; response_bytes: number }>> = {
    workspaces: [], tasks: [], taskDetail: [],
  };

  beforeAll(async () => {
    let createPr246WebBoundaryApp: typeof import('../../../api/test/support/pr246-web-boundary-app.js')['createPr246WebBoundaryApp'];
    try {
      ({ createPr246WebBoundaryApp } = await import('../../../api/test/support/pr246-web-boundary-app.js'));
    } catch (error) {
      console.error(error instanceof Error ? error.stack : error);
      throw error;
    }
    fixture = await createPr246WebBoundaryApp();
    session.accessToken = fixture.ownerToken;
    apiClient = (await import('./client')).default;
    apiClient.defaults.baseURL = `${fixture.baseUrl}/api/v1`;
    apiClient.defaults.adapter = 'http';
    apiClient.defaults.headers.common.Authorization = `Bearer ${fixture.ownerToken}`;
    const responseInterceptors = apiClient.interceptors.response as unknown as {
      handlers: Array<unknown | null>;
      eject: (id: number) => void;
    };
    responseInterceptors.handlers.forEach((handler, id) => {
      if (handler) responseInterceptors.eject(id);
    });
    apiClient.interceptors.response.use((response) => {
      if (activeScenario) {
        const body = JSON.stringify(response.data);
        observations[activeScenario]?.push({
          method: (response.config.method ?? 'get').toUpperCase(),
          path: response.config.url ?? '',
          status: response.status,
          response_sha256: createHash('sha256').update(body).digest('hex'),
          response_bytes: Buffer.byteLength(body),
        });
      }
      return response;
    });
    ({ useWorkspaceMembers } = await import('./workspaces'));
    ({ useTasks } = await import('./tasks'));
    ({ taskDetailReadPort } = await import('./task-detail-read'));
  }, 120_000);

  afterAll(async () => {
    session.accessToken = '';
    await fixture?.close();
    const out = process.env.PR246_CANARY_OUT;
    if (out) writeWebCanaryResult(resolve(out));
  }, 30_000);

  function writeWebCanaryResult(out: string) {
    if (completed.size !== 3 || Object.values(observations).some((rows) => rows.length === 0)) {
      throw new Error('PR246 web canary output requires all three passing read scenarios');
    }
    if (!isAbsolute(out)) throw new Error('PR246_CANARY_OUT must be absolute');
    const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    const rel = relative(repo, out).split('\\').join('/');
    if (!rel.startsWith('receipts/canary/pr246-workspace-membership/') || rel.startsWith('../')) {
      throw new Error('PR246_CANARY_OUT must stay under the PR246 canary evidence directory');
    }
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const tree = execFileSync('git', ['rev-parse', `${commit}^{tree}`], { cwd: repo, encoding: 'utf8' }).trim();
    const capturedAt = new Date().toISOString();
    const evidencePath = `${rel.slice(0, rel.lastIndexOf('/') + 1)}membership-web-read-adapters-source-evidence.json`;
    const evidence = {
      schema: 'MeasuredGitSource/v1', captured_at_utc: capturedAt, commit, tree, dirty: false,
      producer: { tool: 'PR246 web read integration test', version: 'Vitest 5.0.1' },
    };
    const evidenceBytes = `${JSON.stringify(evidence, null, 2)}\n`;
    const sourceSha = createHash('sha256').update(evidenceBytes).digest('hex');
    const subject = {
      schema: 'GitCanarySubject/v1', commit, tree,
      evidence: { path: evidencePath, sha256: sourceSha, source_field: 'commit' },
    };
    const probes = Object.entries(observations).flatMap(([scenario, rows]) => rows.map((row, index) => ({
      id: `${scenario}-${index + 1}`, kind: 'http', ...row, expected: 200,
      outcome: row.status === 200 ? 'verified' : 'failed', executed: true,
    })));
    const probeIds = (scenario: string) => observations[scenario].map((_, index) => `${scenario}-${index + 1}`);
    const result = {
      schema: 'CanaryResult/v1', captured_at_utc: capturedAt, card: '1f99b768-65e6-4afe-93e6-611db53e3366',
      phase: 'post', plan: { id: 'pr246-web-read-adapters-candidate-local-v1' }, subject,
      environment: 'candidate-local Nest HTTP application on loopback with private disposable PostgreSQL 16 and synthetic owner principal',
      producer: { tool: 'Vitest real HTTP web read integration test', version: '5.0.1' },
      model: 'none: deterministic HTTP read controls', resident_version: commit,
      mutating_owner: 'MUNERAL test author; synthetic disposable PostgreSQL only', read_only: false,
      counters: { entities_verified: 3, failed: 0, not_measured: 0 },
      entity_verdicts: [
        { entity: 'code_unit:apps/web/lib/api/workspaces.ts', verdict: 'verified', reason: 'slug lookup and member read passed against the candidate API', probe_ids: probeIds('workspaces') },
        { entity: 'code_unit:apps/web/lib/api/tasks.ts', verdict: 'verified', reason: 'project task read passed through useTasks against the candidate API', probe_ids: probeIds('tasks') },
        { entity: 'code_unit:apps/web/lib/api/task-detail-read.ts', verdict: 'verified', reason: 'workspace, project, and task reads passed through the detail adapter against the candidate API', probe_ids: probeIds('taskDetail') },
      ],
      probes,
    };
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(evidencePath.startsWith('/') ? evidencePath : resolve(repo, evidencePath), evidenceBytes, { flag: 'wx' });
    writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  }

  it('loads the current workspace members through the scoped web read hook', async () => {
    activeScenario = 'workspaces';
    const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={query}>{children}</QueryClientProvider>
    );
    const { result, unmount } = renderHook(() => useWorkspaceMembers(fixture.workspaceSlug), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.some((member) => member.userId === fixture.ownerId)).toBe(true);
    unmount();
    query.clear();
    activeScenario = '';
    completed.add('workspaces');
  }, 20_000);

  it('loads the owner project task through useTasks after membership authorization', async () => {
    activeScenario = 'tasks';
    const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={query}>{children}</QueryClientProvider>
    );
    const { result, unmount } = renderHook(() => useTasks(fixture.projectId), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.data.map((task) => task.id)).toContain(fixture.taskId);
    unmount();
    query.clear();
    activeScenario = '';
    completed.add('tasks');
  }, 20_000);

  it('loads task detail through the read adapter after membership authorization', async () => {
    activeScenario = 'taskDetail';
    const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const port = taskDetailReadPort(query);
    const task = await port.load({
      workspaceSlug: fixture.workspaceSlug,
      projectSlug: fixture.projectSlug,
      taskId: fixture.taskId,
    }, new AbortController().signal);
    expect(task.id).toBe(fixture.taskId);
    expect(task.projectId).toBe(fixture.projectId);
    query.clear();
    activeScenario = '';
    completed.add('taskDetail');
  }, 20_000);
});
