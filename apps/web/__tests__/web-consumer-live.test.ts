// Actual HTTP consumer seam against an isolated candidate; never run against production.
import fs from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderHook, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { apiClient } from '../lib/api/client';
import { fetchWorkspaces } from '../lib/api/workspaces';
import { useTask } from '../lib/api/tasks';
import { taskDetailReadPort } from '../lib/api/task-detail-read';
const state = vi.hoisted(() => ({ authConfig: undefined as any, fixture: undefined as any }));
vi.mock('next-auth', () => ({ default: (config: unknown) => { state.authConfig = config; return {}; } }));
vi.mock('next-auth/react', () => ({ getSession: async () => ({ accessToken: state.fixture?.accessToken }), signOut: async () => {}, useSession: () => ({ status: 'authenticated', data: { accessToken: state.fixture?.accessToken } }), SessionProvider: ({ children }: any) => children }));
vi.mock('next/navigation', () => ({ useParams: () => ({ wsSlug: state.fixture?.workspaceSlug, projSlug: state.fixture?.projectSlug, taskId: state.fixture?.taskId }), useRouter: () => ({ push: () => {} }) }));
import '../lib/auth/nextauth';
import { Providers } from '../app/providers';
import TaskPage from '../app/(app)/workspaces/[wsSlug]/projects/[projSlug]/tasks/[taskId]/page';
import { useProject } from '../lib/api/projects';
import ProjectPage from '../app/(app)/workspaces/[wsSlug]/projects/[projSlug]/page';
import DashboardPage from '../app/(app)/workspaces/[wsSlug]/dashboard/page';
import { useProjectStore } from '../store/project';

const fixturePath=process.env.MUN_ARTIFACT_CANARY_FIXTURE;
describe.skipIf(!fixturePath)('MUN artifact actual web-to-API HTTP consumer seam', () => {
  beforeAll(() => {
    state.fixture=JSON.parse(fs.readFileSync(fixturePath!, 'utf8'));
    if (state.fixture.baseUrl !== 'http://127.0.0.1:25456') throw new Error('Only isolated loopback candidate permitted');
    apiClient.defaults.baseURL=state.fixture.baseUrl+'/api/v1';
    process.env.NEXT_PUBLIC_API_URL=state.fixture.baseUrl;
    // Node HTTP transport still performs real requests; session lookup above is the sole frontend seam.
    apiClient.defaults.adapter='http';
  });
  it('reads real workspace response with the existing workspace consumer', async () => {
    const rows=await fetchWorkspaces();
    expect(rows.some(w=>w.id===state.fixture.workspaceId)).toBe(true);
  });
  it('reads real task response through the existing React task query', async () => {
    const query=new QueryClient({defaultOptions:{queries:{retry:false}}});
    const wrapper=({children}:{children:React.ReactNode})=>React.createElement(QueryClientProvider,{client:query},children);
    const hook=renderHook(()=>useTask(state.fixture.taskId),{wrapper});
    await waitFor(()=>expect(hook.result.current.data?.id).toBe(state.fixture.taskId),{timeout:10000});
    hook.unmount(); query.clear();
  });
  it('binds workspace/project/task identities through actual task detail HTTP reads', async () => {
    const query=new QueryClient();
    const row=await taskDetailReadPort(query).load({workspaceSlug:state.fixture.workspaceSlug,projectSlug:state.fixture.projectSlug,taskId:state.fixture.taskId},new AbortController().signal);
    expect(row.id).toBe(state.fixture.taskId); expect(row.projectId).toBe(state.fixture.projectId);query.clear();
  });
  it('reads the actual project with its existing React query', async () => {
    const query=new QueryClient({defaultOptions:{queries:{retry:false}}});
    const wrapper=({children}:{children:React.ReactNode})=>React.createElement(QueryClientProvider,{client:query},children);
    const hook=renderHook(()=>useProject(state.fixture.workspaceSlug,state.fixture.projectSlug),{wrapper});
    await waitFor(()=>expect(hook.result.current.data?.id).toBe(state.fixture.projectId),{timeout:10000});
    hook.unmount();query.clear();
  });
  it('opens the real task page and reads its checklist through the original UI and HTTP client', async () => {
    const item=(await apiClient.post(`/tasks/${state.fixture.taskId}/checklist`,{text:'Actual checklist HTTP fixture'})).data;
    const view=render(React.createElement(Providers,null,React.createElement(TaskPage)));
    try {
      const checkbox=await screen.findByRole('checkbox',{name:'Actual checklist HTTP fixture'},{timeout:10000});
      expect((checkbox as HTMLInputElement).checked).toBe(false);
      const rows=(await apiClient.get(`/tasks/${state.fixture.taskId}/checklist`)).data;
      expect(rows.some((row:any)=>row.id===item.id && row.checked===false)).toBe(true);
    } finally {
      view.unmount();await apiClient.delete(`/tasks/${state.fixture.taskId}/checklist/${item.id}`);
    }
  });
  it('renders the existing project kanban from the actual project task list', async () => {
    const view=render(React.createElement(Providers,null,React.createElement(ProjectPage)));
    try {
      await screen.findByText('Artifact consumer canary',undefined,{timeout:10000});
      expect(screen.getByText('To Do')).toBeTruthy();
    } finally { view.unmount();useProjectStore.getState().clearProject(); }
  });
  it('renders existing dashboard blockers after reading the actual filtered task list', async () => {
    useProjectStore.getState().setCurrentProject(state.fixture.projectSlug,state.fixture.projectId);
    const view=render(React.createElement(Providers,null,React.createElement(DashboardPage)));
    try { await screen.findByText(/No blockers/,undefined,{timeout:10000}); }
    finally { view.unmount();useProjectStore.getState().clearProject(); }
  });
  it('observes the existing Telegram protocol refusal through the actual NextAuth consumer and API', async () => {
    process.env.TELEGRAM_BOT_TOKEN=state.fixture.telegramBotToken;
    const data:any={id:999001,first_name:'Local fixture',auth_date:Math.floor(Date.now()/1000)};
    const check=Object.entries(data).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');
    data.hash=createHmac('sha256',createHash('sha256').update(state.fixture.telegramBotToken).digest()).update(check).digest('hex');
    const provider=state.authConfig.providers.find((p:any)=>(p.options?.id??p.id)==='telegram');
    const row=await (provider.options?.authorize??provider.authorize)({telegramData:JSON.stringify(data)});
    // The unchanged backend uses WebAppData HMAC while this consumer uses Login Widget SHA256.
    // Record the actual refusal; this is not a successful Telegram login claim.
    expect(row).toBeNull();
    const response=await apiClient.post('/auth/telegram',data,{validateStatus:()=>true});
    expect(response.status).toBe(400); expect(response.data.message).toBe('Invalid Telegram auth data');
  });
});
