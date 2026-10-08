import '@testing-library/jest-dom/vitest';
import { StrictMode } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TaskPage from '@/app/(app)/workspaces/[wsSlug]/projects/[projSlug]/tasks/[taskId]/page';
import { TaskDetailSessionProvider } from '@/lib/api/task-detail-session';

const state = vi.hoisted(() => ({
  session: {data: {accessToken: 'synthetic-session-a'} as {accessToken: string} | null, status: 'authenticated'},
  route: {wsSlug: 'own', projSlug: 'project', taskId: '33333333-3333-4333-8333-333333333333'},
  push: vi.fn(), get: vi.fn(),
}));
vi.mock('next-auth/react', () => ({useSession: () => state.session}));
vi.mock('next/navigation', () => ({useParams: () => state.route, useRouter: () => ({push: state.push})}));
vi.mock('@/lib/api/client', () => ({default: {get: state.get}}));
vi.mock('@/components/task/TaskDetail', () => ({TaskDetail: ({task}: {task: {title: string}}) => <h1>{task.title}</h1>}));
const ws='11111111-1111-4111-8111-111111111111',proj='22222222-2222-4222-8222-222222222222';
const a='33333333-3333-4333-8333-333333333333',b='44444444-4444-4444-8444-444444444444';
const stamp='2026-10-08T00:00:00Z';
const detail=(id:string,title:string)=>({id,projectId:proj,title,status:'todo',priority:'medium',actorType:'human',createdAt:stamp,updatedAt:stamp});
const pending: {id:string;principal:string|undefined;resolve:(value:unknown)=>void}[]=[];
beforeEach(()=>{
  state.session={data:{accessToken:'synthetic-session-a'},status:'authenticated'};
  state.route={wsSlug:'own',projSlug:'project',taskId:a};state.push.mockReset();state.get.mockReset();pending.length=0;
  state.get.mockImplementation((url:string)=>{
    if(url==='/workspaces')return Promise.resolve({data:[{id:ws,slug:'own',name:'Own',createdAt:stamp}]});
    if(url==='/projects/workspace/'+ws)return Promise.resolve({data:[{id:proj,workspaceId:ws,slug:'project',name:'Project',createdAt:stamp}]});
    return new Promise(resolve=>pending.push({id:url.split('/').pop()!,principal:state.session.data?.accessToken,resolve: data=>resolve({data})}));
  });
});
afterEach(cleanup);
const App=()=> <StrictMode><TaskDetailSessionProvider><TaskPage /></TaskDetailSessionProvider></StrictMode>;
async function response(id:string,principal:string,title:string) {
  await waitFor(()=>expect(pending.some(p=>p.id===id&&p.principal===principal)).toBe(true));
  await act(async()=>{pending.filter(p=>p.id===id&&p.principal===principal).forEach(p=>p.resolve(detail(id,title)));});
}
describe('I05 page/provider integration (jsdom, not real Next hydration)',()=>{
  it('survives React strict lifecycle rehearsal and renders a committed direct route',async()=>{
    render(<App/>);await response(a,'synthetic-session-a','Own task');
    expect(await screen.findByRole('heading',{name:'Own task'})).toBeInTheDocument();
    expect(state.push).not.toHaveBeenCalled();
  });
  it('a route switch hides old content and a late A cannot replace ready B',async()=>{
    const view=render(<App/>);
    await waitFor(()=>expect(pending.some(p=>p.id===a)).toBe(true));
    state.route={...state.route,taskId:b};view.rerender(<App/>);
    await response(b,'synthetic-session-a','B task');
    await response(a,'synthetic-session-a','Late A secret');
    expect(screen.getByRole('heading',{name:'B task'})).toBeInTheDocument();
    expect(screen.queryByText('Late A secret')).not.toBeInTheDocument();
  });
  it('same-task identity replacement gets a fresh projection and cannot reuse the previous session',async()=>{
    const view=render(<App/>);await response(a,'synthetic-session-a','A principal secret');
    expect(await screen.findByText('A principal secret')).toBeInTheDocument();
    state.session={data:{accessToken:'synthetic-session-b'},status:'authenticated'};view.rerender(<App/>);
    expect(screen.queryByText('A principal secret')).not.toBeInTheDocument();
    await response(a,'synthetic-session-b','B principal task');
    expect(await screen.findByText('B principal task')).toBeInTheDocument();
  });
  it('logout during a read fences a transport that returns old protected content',async()=>{
    const view=render(<App/>);await waitFor(()=>expect(pending.some(p=>p.id===a)).toBe(true));
    state.session={data:null,status:'unauthenticated'};view.rerender(<App/>);
    await response(a,'synthetic-session-a','Revoked secret');
    expect(screen.getByRole('alert')).toHaveTextContent('Task access denied');
    expect(screen.queryByText('Revoked secret')).not.toBeInTheDocument();
  });
  it('loading identity state removes already-ready protected content',async()=>{
    const view=render(<App/>);await response(a,'synthetic-session-a','Ready secret');
    expect(await screen.findByText('Ready secret')).toBeInTheDocument();
    state.session={data:state.session.data,status:'loading'};view.rerender(<App/>);
    expect(screen.queryByText('Ready secret')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Task access denied');
  });
});
