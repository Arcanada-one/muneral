// Actual HTTP consumer seam against an isolated candidate; never run against production.
import fs from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { apiClient } from '../lib/api/client';
import { fetchWorkspaces } from '../lib/api/workspaces';
import { useTask } from '../lib/api/tasks';
import { taskDetailReadPort } from '../lib/api/task-detail-read';
const state = vi.hoisted(() => ({ authConfig: undefined as any, fixture: undefined as any }));
vi.mock('next-auth', () => ({ default: (config: unknown) => { state.authConfig = config; return {}; } }));
vi.mock('next-auth/react', () => ({ getSession: async () => ({ accessToken: state.fixture?.accessToken }), signOut: async () => {} }));
import '../lib/auth/nextauth';

const fixturePath=process.env.MUN_ARTIFACT_CANARY_FIXTURE;
describe.skipIf(!fixturePath)('MUN artifact actual web-to-API HTTP consumer seam', () => {
  beforeAll(() => {
    state.fixture=JSON.parse(fs.readFileSync(fixturePath!, 'utf8'));
    if (state.fixture.baseUrl !== 'http://127.0.0.1:25456') throw new Error('Only isolated loopback candidate permitted');
    apiClient.defaults.baseURL=state.fixture.baseUrl+'/api/v1';
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

  it('uploads lists and reads back artifact bytes through the web apiClient', async () => {
    // Agent-scoped task-evidence key rides the same axios consumer the dashboard uses.
    const agentKey=state.fixture.agentKey;
    if (typeof agentKey !== 'string' || agentKey.length === 0) {
      throw new Error('Fixture must supply agentKey for artifact upload/list/get/readback');
    }
    const auth={Authorization:`Bearer ${agentKey}`};
    const body=Buffer.from(`web-canary-artifact:${state.fixture.taskId}`, 'utf8');
    const sha=createHash('sha256').update(body).digest('hex');
    const uploaded=await apiClient.post(`/tasks/${state.fixture.taskId}/artifacts`, {
      name:'web-canary.json',
      contentType:'application/json',
      contentBase64:body.toString('base64'),
      sha256:sha,
    }, {headers:auth, validateStatus:()=>true});
    expect(uploaded.status).toBe(201);
    expect(uploaded.data).toMatchObject({sha256:sha, sizeBytes:body.length});
    expect(uploaded.data.contentBase64).toBeUndefined();

    const listed=await apiClient.get(`/tasks/${state.fixture.taskId}/artifacts`, {headers:auth, validateStatus:()=>true});
    expect(listed.status).toBe(200);
    expect(listed.data.total).toBeGreaterThanOrEqual(1);
    expect(listed.data.data.some((row: {id:string})=>row.id===uploaded.data.id)).toBe(true);

    const byId=await apiClient.get(`/tasks/${state.fixture.taskId}/artifacts/${uploaded.data.id}`, {headers:auth, validateStatus:()=>true});
    expect(byId.status).toBe(200);
    expect(byId.data.contentBase64).toBe(body.toString('base64'));
    expect(createHash('sha256').update(Buffer.from(byId.data.contentBase64,'base64')).digest('hex')).toBe(sha);

    const bySha=await apiClient.get(`/tasks/${state.fixture.taskId}/artifacts/by-sha/${sha}`, {headers:auth, validateStatus:()=>true});
    expect(bySha.status).toBe(200);
    expect(bySha.data.id).toBe(uploaded.data.id);
    expect(bySha.data.contentBase64).toBe(body.toString('base64'));
  });
});
